// 墨阅 · 桌面宿主程序
//
// 职责：
//   1. 创建主窗口与内嵌浏览器控件，标题栏颜色跟随阅读主题；
//   2. 以 https://app.local/ 提供界面资源（默认来自 exe 内嵌资源，开发时可指向磁盘目录）；
//   3. 以 https://app.local/@fs/<路径> 提供本地文件读取（Markdown 正文与相对路径图片）；
//   4. 阅读状态由后台线程“写临时文件 + 原子替换”落盘，关闭窗口前向页面索取最新进度再保存；
//   5. 单实例运行（再次打开文件时转交给已运行的窗口）、文件变化监视、打开/保存对话框、全屏等。

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shlwapi.h>
#include <shobjidl.h>
#include <dwmapi.h>
#include <wrl.h>

#include <algorithm>
#include <condition_variable>
#include <cwctype>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#include "WebView2.h"
#include "resource.h"
#include "web_resources.h"

using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;

namespace {

// ───────────────────────── 常量 ─────────────────────────
constexpr wchar_t kAppName[] = L"墨阅";
constexpr wchar_t kAppVersion[] = L"1.0.0";
constexpr wchar_t kWindowClass[] = L"MoYueReaderWindow";
constexpr wchar_t kMutexName[] = L"Local\\MoYueReader.SingleInstance";
constexpr wchar_t kDataFolderName[] = L"MoYueReader";
constexpr wchar_t kOrigin[] = L"https://app.local/";
constexpr ULONG_PTR kCopyDataOpen = 0x4D59;  // 单实例转发：打开文件
constexpr UINT_PTR kTimerWatch = 1;           // 文件变化轮询
constexpr UINT_PTR kTimerCloseTimeout = 2;    // 关闭等待超时
constexpr UINT kWatchIntervalMs = 700;

// 窗口标题栏相关的系统属性编号（较新系统支持）
constexpr DWORD kDwmUseDarkMode = 20;
constexpr DWORD kDwmCaptionColor = 35;
constexpr DWORD kDwmTextColor = 36;

// ───────────────────────── 全局状态 ─────────────────────────
HINSTANCE g_inst = nullptr;
HWND g_hwnd = nullptr;
ComPtr<ICoreWebView2Environment> g_env;
ComPtr<ICoreWebView2Controller> g_controller;
ComPtr<ICoreWebView2> g_webview;

std::wstring g_exeDir;
std::wstring g_dataDir;        // 阅读状态与设置所在目录
std::wstring g_cacheDir;       // 浏览器缓存目录
std::wstring g_stateFile;      // 阅读状态文件 state.json
std::wstring g_iniFile;        // 窗口位置等 window.ini
std::wstring g_devWebDir;      // 开发模式：从磁盘目录提供界面资源
std::wstring g_pendingOpen;    // 页面就绪前收到的待打开文件
bool g_pageReady = false;

COLORREF g_bgColor = RGB(0xFA, 0xF9, 0xF5);
COLORREF g_fgColor = RGB(0x2B, 0x29, 0x23);
bool g_darkTheme = false;
HBRUSH g_bgBrush = nullptr;

bool g_closing = false;
bool g_closeFinished = false;
bool g_fullscreen = false;
WINDOWPLACEMENT g_prevPlacement = {sizeof(WINDOWPLACEMENT)};

// 文件监视
std::wstring g_watchPath;
FILETIME g_watchTime = {};
ULONGLONG g_watchSize = 0;
bool g_watchDirty = false;

// 后台写盘线程（合并频繁的保存请求，只写最新一份）
std::mutex g_saveMutex;
std::condition_variable g_saveCv;
std::string g_savePending;
bool g_saveHas = false;
bool g_saveQuit = false;
bool g_backupDone = false;
std::thread g_saveThread;

// ───────────────────────── 字符串工具 ─────────────────────────
std::string ToUtf8(const std::wstring& w) {
  if (w.empty()) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr);
  std::string s(static_cast<size_t>(n), '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), s.data(), n, nullptr, nullptr);
  return s;
}

std::wstring FromUtf8(const char* p, size_t len) {
  if (!len) return {};
  int n = MultiByteToWideChar(CP_UTF8, 0, p, static_cast<int>(len), nullptr, 0);
  std::wstring w(static_cast<size_t>(n), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, p, static_cast<int>(len), w.data(), n);
  return w;
}

std::wstring FromUtf8(const std::string& s) { return FromUtf8(s.data(), s.size()); }

std::wstring ToLower(std::wstring s) {
  for (auto& c : s) c = static_cast<wchar_t>(std::towlower(c));
  return s;
}

bool StartsWith(const std::wstring& s, const wchar_t* prefix) {
  size_t n = wcslen(prefix);
  return s.size() >= n && s.compare(0, n, prefix) == 0;
}

int HexValue(wchar_t c) {
  if (c >= L'0' && c <= L'9') return c - L'0';
  if (c >= L'a' && c <= L'f') return c - L'a' + 10;
  if (c >= L'A' && c <= L'F') return c - L'A' + 10;
  return -1;
}

// 地址中的百分号编码按 UTF-8 解码
std::wstring PercentDecode(const std::wstring& s) {
  std::string bytes;
  bytes.reserve(s.size());
  for (size_t i = 0; i < s.size(); ++i) {
    wchar_t c = s[i];
    if (c == L'%' && i + 2 < s.size() && HexValue(s[i + 1]) >= 0 && HexValue(s[i + 2]) >= 0) {
      bytes.push_back(static_cast<char>((HexValue(s[i + 1]) << 4) | HexValue(s[i + 2])));
      i += 2;
    } else if (c < 0x80) {
      bytes.push_back(static_cast<char>(c));
    } else {
      size_t j = i;
      while (j < s.size() && s[j] >= 0x80) ++j;
      bytes += ToUtf8(s.substr(i, j - i));
      i = j - 1;
    }
  }
  return FromUtf8(bytes);
}

// 生成 JSON 字符串字面量
std::wstring JsonString(const std::wstring& s) {
  std::wstring o;
  o.reserve(s.size() + 16);
  o += L'"';
  for (wchar_t c : s) {
    switch (c) {
      case L'"': o += L"\\\""; break;
      case L'\\': o += L"\\\\"; break;
      case L'\n': o += L"\\n"; break;
      case L'\r': o += L"\\r"; break;
      case L'\t': o += L"\\t"; break;
      default:
        if (c < 0x20 || c == 0x2028 || c == 0x2029) {
          wchar_t buf[8];
          swprintf_s(buf, L"\\u%04x", static_cast<unsigned>(c));
          o += buf;
        } else {
          o += c;
        }
    }
  }
  o += L'"';
  return o;
}

// 解析单个 JSON 字符串字面量（用于读取页面脚本的返回值）
bool JsonUnquote(const wchar_t* s, std::wstring& out) {
  size_t n = wcslen(s);
  if (n < 2 || s[0] != L'"') return false;
  out.clear();
  out.reserve(n);
  for (size_t i = 1; i < n; ++i) {
    wchar_t c = s[i];
    if (c == L'"') return true;
    if (c != L'\\') { out += c; continue; }
    if (++i >= n) return false;
    switch (s[i]) {
      case L'"': out += L'"'; break;
      case L'\\': out += L'\\'; break;
      case L'/': out += L'/'; break;
      case L'b': out += L'\b'; break;
      case L'f': out += L'\f'; break;
      case L'n': out += L'\n'; break;
      case L'r': out += L'\r'; break;
      case L't': out += L'\t'; break;
      case L'u': {
        if (i + 4 >= n) return false;
        unsigned v = 0;
        for (int k = 1; k <= 4; ++k) {
          int hv = HexValue(s[i + k]);
          if (hv < 0) return false;
          v = (v << 4) | static_cast<unsigned>(hv);
        }
        out += static_cast<wchar_t>(v);
        i += 4;
        break;
      }
      default: return false;
    }
  }
  return false;
}

std::vector<std::wstring> Split(const std::wstring& s, wchar_t sep) {
  std::vector<std::wstring> parts;
  size_t start = 0;
  for (;;) {
    size_t p = s.find(sep, start);
    if (p == std::wstring::npos) { parts.push_back(s.substr(start)); break; }
    parts.push_back(s.substr(start, p - start));
    start = p + 1;
  }
  return parts;
}

// "#RRGGBB" → COLORREF
bool ParseHexColor(const std::wstring& s, COLORREF& out) {
  if (s.size() != 7 || s[0] != L'#') return false;
  int v[6];
  for (int i = 0; i < 6; ++i) {
    v[i] = HexValue(s[static_cast<size_t>(i) + 1]);
    if (v[i] < 0) return false;
  }
  out = RGB(v[0] * 16 + v[1], v[2] * 16 + v[3], v[4] * 16 + v[5]);
  return true;
}

std::wstring ColorToHex(COLORREF c) {
  wchar_t buf[16];
  swprintf_s(buf, L"#%02X%02X%02X", GetRValue(c), GetGValue(c), GetBValue(c));
  return buf;
}

// ───────────────────────── 文件工具 ─────────────────────────
std::wstring FullPath(const std::wstring& p) {
  DWORD n = GetFullPathNameW(p.c_str(), 0, nullptr, nullptr);
  if (!n) return p;
  std::wstring out(n, L'\0');
  DWORD m = GetFullPathNameW(p.c_str(), n, out.data(), nullptr);
  out.resize(m);
  return out;
}

bool FileExists(const std::wstring& p) {
  DWORD a = GetFileAttributesW(p.c_str());
  return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY);
}

bool DirExists(const std::wstring& p) {
  DWORD a = GetFileAttributesW(p.c_str());
  return a != INVALID_FILE_ATTRIBUTES && (a & FILE_ATTRIBUTE_DIRECTORY);
}

bool ReadAllBytes(const std::wstring& path, std::string& out, ULONGLONG maxSize = 1024ull * 1024 * 1024) {
  HANDLE h = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                         OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
  if (h == INVALID_HANDLE_VALUE) return false;
  LARGE_INTEGER size{};
  if (!GetFileSizeEx(h, &size) || static_cast<ULONGLONG>(size.QuadPart) > maxSize) {
    CloseHandle(h);
    return false;
  }
  out.resize(static_cast<size_t>(size.QuadPart));
  size_t done = 0;
  while (done < out.size()) {
    DWORD chunk = static_cast<DWORD>(std::min<size_t>(out.size() - done, 16u * 1024 * 1024));
    DWORD got = 0;
    if (!ReadFile(h, out.data() + done, chunk, &got, nullptr) || got == 0) break;
    done += got;
  }
  out.resize(done);
  CloseHandle(h);
  return true;
}

std::wstring ReadTextFile(const std::wstring& path) {
  std::string bytes;
  if (!ReadAllBytes(path, bytes, 64ull * 1024 * 1024)) return {};
  if (bytes.size() >= 3 && static_cast<unsigned char>(bytes[0]) == 0xEF && static_cast<unsigned char>(bytes[1]) == 0xBB &&
      static_cast<unsigned char>(bytes[2]) == 0xBF) {
    bytes.erase(0, 3);
  }
  return FromUtf8(bytes);
}

// 原子写入：先写临时文件并刷盘，再替换目标文件；任何时刻目标文件都是完整的
bool WriteFileAtomic(const std::wstring& path, const std::string& data) {
  std::wstring tmp = path + L".tmp";
  HANDLE h = CreateFileW(tmp.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (h == INVALID_HANDLE_VALUE) return false;
  size_t done = 0;
  bool ok = true;
  while (done < data.size()) {
    DWORD wrote = 0;
    DWORD chunk = static_cast<DWORD>(std::min<size_t>(data.size() - done, 16u * 1024 * 1024));
    if (!WriteFile(h, data.data() + done, chunk, &wrote, nullptr) || wrote == 0) { ok = false; break; }
    done += wrote;
  }
  if (ok) ok = FlushFileBuffers(h) != FALSE;
  CloseHandle(h);
  if (!ok) { DeleteFileW(tmp.c_str()); return false; }
  for (int attempt = 0; attempt < 5; ++attempt) {
    if (MoveFileExW(tmp.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) return true;
    Sleep(30);  // 目标文件可能被杀毒或同步软件短暂占用
  }
  DeleteFileW(tmp.c_str());
  return false;
}

std::wstring MimeFor(const std::wstring& path) {
  static const std::unordered_map<std::wstring, std::wstring> kTypes = {
      {L".html", L"text/html; charset=utf-8"}, {L".htm", L"text/html; charset=utf-8"},
      {L".js", L"text/javascript; charset=utf-8"}, {L".mjs", L"text/javascript; charset=utf-8"},
      {L".css", L"text/css; charset=utf-8"}, {L".json", L"application/json; charset=utf-8"},
      {L".svg", L"image/svg+xml"}, {L".png", L"image/png"}, {L".jpg", L"image/jpeg"}, {L".jpeg", L"image/jpeg"},
      {L".gif", L"image/gif"}, {L".webp", L"image/webp"}, {L".bmp", L"image/bmp"}, {L".ico", L"image/x-icon"},
      {L".avif", L"image/avif"}, {L".woff2", L"font/woff2"}, {L".woff", L"font/woff"}, {L".ttf", L"font/ttf"},
      {L".otf", L"font/otf"}, {L".md", L"text/plain; charset=utf-8"}, {L".markdown", L"text/plain; charset=utf-8"},
      {L".txt", L"text/plain; charset=utf-8"}, {L".mp4", L"video/mp4"}, {L".webm", L"video/webm"},
      {L".mp3", L"audio/mpeg"}, {L".ogg", L"audio/ogg"}, {L".wav", L"audio/wav"}, {L".pdf", L"application/pdf"},
  };
  size_t dot = path.find_last_of(L'.');
  size_t slash = path.find_last_of(L"/\\");
  if (dot == std::wstring::npos || (slash != std::wstring::npos && dot < slash)) return L"application/octet-stream";
  auto it = kTypes.find(ToLower(path.substr(dot)));
  return it == kTypes.end() ? L"application/octet-stream" : it->second;
}

// ───────────────────────── 后台写盘 ─────────────────────────
void SaverLoop() {
  for (;;) {
    std::string data;
    {
      std::unique_lock<std::mutex> lock(g_saveMutex);
      g_saveCv.wait(lock, [] { return g_saveHas || g_saveQuit; });
      if (!g_saveHas && g_saveQuit) break;
      data.swap(g_savePending);
      g_saveHas = false;
    }
    // 每次运行第一次保存前，备份上一次会话的状态，作为状态文件损坏时的后备
    if (!g_backupDone) {
      g_backupDone = true;
      if (FileExists(g_stateFile)) CopyFileW(g_stateFile.c_str(), (g_stateFile + L".bak").c_str(), FALSE);
    }
    WriteFileAtomic(g_stateFile, data);
  }
}

void QueueSave(std::string data) {
  {
    std::lock_guard<std::mutex> lock(g_saveMutex);
    g_savePending = std::move(data);
    g_saveHas = true;
  }
  g_saveCv.notify_one();
}

// 停止写盘线程：会先把尚未写入的最新状态写完
void StopSaver() {
  if (!g_saveThread.joinable()) return;
  {
    std::lock_guard<std::mutex> lock(g_saveMutex);
    g_saveQuit = true;
  }
  g_saveCv.notify_one();
  g_saveThread.join();
}

// ───────────────────────── 目录初始化 ─────────────────────────
std::wstring KnownFolder(REFKNOWNFOLDERID id) {
  PWSTR p = nullptr;
  std::wstring out;
  if (SUCCEEDED(SHGetKnownFolderPath(id, KF_FLAG_CREATE, nullptr, &p)) && p) out = p;
  if (p) CoTaskMemFree(p);
  return out;
}

void InitPaths() {
  wchar_t buf[MAX_PATH * 4];
  DWORD n = GetModuleFileNameW(nullptr, buf, static_cast<DWORD>(std::size(buf)));
  g_exeDir.assign(buf, n);
  g_exeDir.resize(g_exeDir.find_last_of(L'\\'));

  // 便携模式：exe 同目录下存在 data 文件夹时，所有数据都放在其中
  std::wstring portable = g_exeDir + L"\\data";
  if (DirExists(portable)) {
    g_dataDir = portable;
    g_cacheDir = portable + L"\\cache";
  } else {
    g_dataDir = KnownFolder(FOLDERID_RoamingAppData) + L"\\" + kDataFolderName;
    g_cacheDir = KnownFolder(FOLDERID_LocalAppData) + L"\\" + kDataFolderName + L"\\cache";
  }
  SHCreateDirectoryExW(nullptr, g_dataDir.c_str(), nullptr);
  SHCreateDirectoryExW(nullptr, g_cacheDir.c_str(), nullptr);
  g_stateFile = g_dataDir + L"\\state.json";
  g_iniFile = g_dataDir + L"\\window.ini";

  // 开发模式：exe 旁边有 web 目录时直接使用（修改界面无需重新编译）
  if (g_devWebDir.empty() && FileExists(g_exeDir + L"\\web\\index.html")) g_devWebDir = g_exeDir + L"\\web";
}

// ───────────────────────── 与页面通信 ─────────────────────────
void PostJson(const std::wstring& json) {
  if (g_webview) g_webview->PostWebMessageAsJson(json.c_str());
}

void PostOpen(const std::wstring& path) {
  if (path.empty()) return;
  if (!g_pageReady) {
    g_pendingOpen = path;
    return;
  }
  PostJson(L"{\"type\":\"open\",\"path\":" + JsonString(path) + L"}");
}

void PostToast(const std::wstring& message) {
  PostJson(L"{\"type\":\"toast\",\"message\":" + JsonString(message) + L"}");
}

void SendInit() {
  std::wstring state = ReadTextFile(g_stateFile);
  std::wstring backup = ReadTextFile(g_stateFile + L".bak");
  std::wstring json = L"{\"type\":\"init\",\"native\":true,\"version\":" + JsonString(kAppVersion) +
                      L",\"state\":" + (state.empty() ? L"null" : JsonString(state)) +
                      L",\"stateBak\":" + (backup.empty() ? L"null" : JsonString(backup)) +
                      L",\"open\":" + JsonString(g_pendingOpen) + L",\"dataDir\":" + JsonString(g_dataDir) + L"}";
  g_pendingOpen.clear();
  g_pageReady = true;
  PostJson(json);
}

// ───────────────────────── 外观 ─────────────────────────
void ApplyWindowColors() {
  if (!g_hwnd) return;
  BOOL dark = g_darkTheme ? TRUE : FALSE;
  DwmSetWindowAttribute(g_hwnd, kDwmUseDarkMode, &dark, sizeof(dark));
  DwmSetWindowAttribute(g_hwnd, kDwmCaptionColor, &g_bgColor, sizeof(g_bgColor));
  DwmSetWindowAttribute(g_hwnd, kDwmTextColor, &g_fgColor, sizeof(g_fgColor));
  // 窗口底色与页面背景一致，避免缩放窗口时出现白边
  HBRUSH brush = CreateSolidBrush(g_bgColor);
  SetClassLongPtrW(g_hwnd, GCLP_HBRBACKGROUND, reinterpret_cast<LONG_PTR>(brush));
  if (g_bgBrush) DeleteObject(g_bgBrush);
  g_bgBrush = brush;
  if (g_controller) {
    ComPtr<ICoreWebView2Controller2> c2;
    if (SUCCEEDED(g_controller.As(&c2))) {
      COREWEBVIEW2_COLOR color{255, GetRValue(g_bgColor), GetGValue(g_bgColor), GetBValue(g_bgColor)};
      c2->put_DefaultBackgroundColor(color);
    }
  }
}

void SetTheme(const std::wstring& bg, const std::wstring& fg, bool dark) {
  COLORREF b, f;
  if (!ParseHexColor(bg, b) || !ParseHexColor(fg, f)) return;
  if (b == g_bgColor && f == g_fgColor && dark == g_darkTheme) return;
  g_bgColor = b;
  g_fgColor = f;
  g_darkTheme = dark;
  ApplyWindowColors();
  // 记住配色，下次启动时窗口一出现就是正确的颜色
  WritePrivateProfileStringW(L"theme", L"bg", ColorToHex(b).c_str(), g_iniFile.c_str());
  WritePrivateProfileStringW(L"theme", L"fg", ColorToHex(f).c_str(), g_iniFile.c_str());
  WritePrivateProfileStringW(L"theme", L"dark", dark ? L"1" : L"0", g_iniFile.c_str());
}

void LoadThemeFromIni() {
  wchar_t buf[32];
  COLORREF c;
  GetPrivateProfileStringW(L"theme", L"bg", L"", buf, 32, g_iniFile.c_str());
  if (ParseHexColor(buf, c)) g_bgColor = c;
  GetPrivateProfileStringW(L"theme", L"fg", L"", buf, 32, g_iniFile.c_str());
  if (ParseHexColor(buf, c)) g_fgColor = c;
  g_darkTheme = GetPrivateProfileIntW(L"theme", L"dark", 0, g_iniFile.c_str()) != 0;
}

// ───────────────────────── 窗口位置 ─────────────────────────
void SaveWindowPlacement() {
  WINDOWPLACEMENT wp = {sizeof(wp)};
  if (g_fullscreen) wp = g_prevPlacement;
  else if (!GetWindowPlacement(g_hwnd, &wp)) return;
  WritePrivateProfileStructW(L"window", L"placement", &wp, sizeof(wp), g_iniFile.c_str());
}

void RestoreWindowPlacement(int nCmdShow) {
  WINDOWPLACEMENT wp = {sizeof(wp)};
  if (GetPrivateProfileStructW(L"window", L"placement", &wp, sizeof(wp), g_iniFile.c_str()) && wp.length == sizeof(wp)) {
    if (wp.showCmd == SW_SHOWMINIMIZED || wp.showCmd == SW_MINIMIZE || wp.showCmd == SW_HIDE) wp.showCmd = SW_SHOWNORMAL;
    if (nCmdShow == SW_SHOWMINIMIZED || nCmdShow == SW_MINIMIZE || nCmdShow == SW_SHOWMINNOACTIVE) wp.showCmd = nCmdShow;
    wp.flags = 0;
    SetWindowPlacement(g_hwnd, &wp);
    return;
  }
  // 首次启动：在主屏工作区居中显示
  UINT dpi = GetDpiForWindow(g_hwnd);
  MONITORINFO mi = {sizeof(mi)};
  GetMonitorInfoW(MonitorFromWindow(g_hwnd, MONITOR_DEFAULTTOPRIMARY), &mi);
  RECT wa = mi.rcWork;
  int ww = std::min(MulDiv(1280, static_cast<int>(dpi), 96), static_cast<int>((wa.right - wa.left) * 0.9));
  int wh = std::min(MulDiv(860, static_cast<int>(dpi), 96), static_cast<int>((wa.bottom - wa.top) * 0.9));
  SetWindowPos(g_hwnd, nullptr, wa.left + (wa.right - wa.left - ww) / 2, wa.top + (wa.bottom - wa.top - wh) / 2, ww, wh,
               SWP_NOZORDER | SWP_NOACTIVATE);
  ShowWindow(g_hwnd, nCmdShow == SW_SHOWMAXIMIZED ? SW_SHOWMAXIMIZED : SW_SHOWNORMAL);
}

void ToggleFullscreen() {
  DWORD style = static_cast<DWORD>(GetWindowLongW(g_hwnd, GWL_STYLE));
  if (!g_fullscreen) {
    MONITORINFO mi = {sizeof(mi)};
    if (GetWindowPlacement(g_hwnd, &g_prevPlacement) &&
        GetMonitorInfoW(MonitorFromWindow(g_hwnd, MONITOR_DEFAULTTOPRIMARY), &mi)) {
      SetWindowLongW(g_hwnd, GWL_STYLE, static_cast<LONG>(style & ~WS_OVERLAPPEDWINDOW));
      SetWindowPos(g_hwnd, HWND_TOP, mi.rcMonitor.left, mi.rcMonitor.top, mi.rcMonitor.right - mi.rcMonitor.left,
                   mi.rcMonitor.bottom - mi.rcMonitor.top, SWP_NOOWNERZORDER | SWP_FRAMECHANGED);
      g_fullscreen = true;
    }
  } else {
    SetWindowLongW(g_hwnd, GWL_STYLE, static_cast<LONG>(style | WS_OVERLAPPEDWINDOW));
    SetWindowPlacement(g_hwnd, &g_prevPlacement);
    SetWindowPos(g_hwnd, nullptr, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_FRAMECHANGED);
    g_fullscreen = false;
  }
  PostJson(std::wstring(L"{\"type\":\"fullscreen\",\"on\":") + (g_fullscreen ? L"true" : L"false") + L"}");
}

void ActivateMainWindow() {
  if (IsIconic(g_hwnd)) ShowWindow(g_hwnd, SW_RESTORE);
  SetForegroundWindow(g_hwnd);
}

// ───────────────────────── 文件监视 ─────────────────────────
void StartWatch(const std::wstring& path) {
  g_watchPath = path;
  g_watchDirty = false;
  KillTimer(g_hwnd, kTimerWatch);
  if (path.empty()) return;
  WIN32_FILE_ATTRIBUTE_DATA fad{};
  if (GetFileAttributesExW(path.c_str(), GetFileExInfoStandard, &fad)) {
    g_watchTime = fad.ftLastWriteTime;
    g_watchSize = (static_cast<ULONGLONG>(fad.nFileSizeHigh) << 32) | fad.nFileSizeLow;
  }
  SetTimer(g_hwnd, kTimerWatch, kWatchIntervalMs, nullptr);
}

// 发现修改后等到文件稳定（连续一次轮询无变化）再通知页面，避免编辑器分段写入时读到半截内容
void CheckWatch() {
  if (g_watchPath.empty()) return;
  WIN32_FILE_ATTRIBUTE_DATA fad{};
  if (!GetFileAttributesExW(g_watchPath.c_str(), GetFileExInfoStandard, &fad)) return;
  ULONGLONG size = (static_cast<ULONGLONG>(fad.nFileSizeHigh) << 32) | fad.nFileSizeLow;
  if (CompareFileTime(&fad.ftLastWriteTime, &g_watchTime) != 0 || size != g_watchSize) {
    g_watchTime = fad.ftLastWriteTime;
    g_watchSize = size;
    g_watchDirty = true;
    return;
  }
  if (g_watchDirty) {
    g_watchDirty = false;
    PostJson(L"{\"type\":\"file-changed\",\"path\":" + JsonString(g_watchPath) + L"}");
  }
}

// ───────────────────────── 对话框与外部操作 ─────────────────────────
void ShowOpenDialog() {
  ComPtr<IFileOpenDialog> dlg;
  if (FAILED(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dlg)))) return;
  COMDLG_FILTERSPEC filters[] = {
      {L"Markdown 文档", L"*.md;*.markdown;*.mdown;*.mkd;*.mkdn;*.mdx"},
      {L"纯文本", L"*.txt"},
      {L"所有文件", L"*.*"},
  };
  dlg->SetFileTypes(static_cast<UINT>(std::size(filters)), filters);
  dlg->SetTitle(L"打开 Markdown 文件");
  DWORD opts = 0;
  dlg->GetOptions(&opts);
  dlg->SetOptions(opts | FOS_FORCEFILESYSTEM | FOS_FILEMUSTEXIST);
  if (FAILED(dlg->Show(g_hwnd))) return;
  ComPtr<IShellItem> item;
  if (FAILED(dlg->GetResult(&item))) return;
  PWSTR p = nullptr;
  if (SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &p)) && p) {
    PostOpen(p);
    CoTaskMemFree(p);
  }
}

void SaveTextDialog(const std::wstring& suggested, const std::wstring& text) {
  ComPtr<IFileSaveDialog> dlg;
  if (FAILED(CoCreateInstance(CLSID_FileSaveDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dlg)))) return;
  COMDLG_FILTERSPEC filters[] = {{L"JSON 文件", L"*.json"}, {L"所有文件", L"*.*"}};
  dlg->SetFileTypes(static_cast<UINT>(std::size(filters)), filters);
  dlg->SetDefaultExtension(L"json");
  dlg->SetFileName(suggested.c_str());
  dlg->SetTitle(L"保存");
  if (FAILED(dlg->Show(g_hwnd))) return;
  ComPtr<IShellItem> item;
  if (FAILED(dlg->GetResult(&item))) return;
  PWSTR p = nullptr;
  if (SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &p)) && p) {
    std::wstring path = p;
    CoTaskMemFree(p);
    if (WriteFileAtomic(path, ToUtf8(text))) PostJson(L"{\"type\":\"saved\",\"path\":" + JsonString(path) + L"}");
    else PostToast(L"保存失败，请检查目标位置是否可写");
  }
}

void OpenExternal(const std::wstring& url) {
  std::wstring lower = ToLower(url);
  if (!StartsWith(lower, L"http://") && !StartsWith(lower, L"https://") && !StartsWith(lower, L"mailto:")) return;
  ShellExecuteW(g_hwnd, L"open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
}

void RevealInExplorer(const std::wstring& path) {
  std::wstring full = FullPath(path);
  if (!FileExists(full) && !DirExists(full)) {
    PostToast(L"找不到该文件：" + full);
    return;
  }
  PIDLIST_ABSOLUTE pidl = ILCreateFromPathW(full.c_str());
  if (pidl) {
    SHOpenFolderAndSelectItems(pidl, 0, nullptr, 0);
    ILFree(pidl);
  }
}

int CALLBACK FontEnumProc(const LOGFONTW* lf, const TEXTMETRICW*, DWORD, LPARAM lp) {
  if (lf->lfFaceName[0] != L'@') reinterpret_cast<std::set<std::wstring>*>(lp)->insert(lf->lfFaceName);
  return 1;
}

void SendFontList() {
  std::set<std::wstring> names;
  LOGFONTW lf = {};
  lf.lfCharSet = DEFAULT_CHARSET;
  HDC dc = GetDC(nullptr);
  EnumFontFamiliesExW(dc, &lf, FontEnumProc, reinterpret_cast<LPARAM>(&names), 0);
  ReleaseDC(nullptr, dc);
  std::wstring json = L"{\"type\":\"fonts\",\"list\":[";
  bool first = true;
  for (const auto& n : names) {
    if (!first) json += L',';
    json += JsonString(n);
    first = false;
  }
  json += L"]}";
  PostJson(json);
}

// 拖入窗口的文件：从附带对象中取得真实路径
void HandleDroppedFiles(ICoreWebView2WebMessageReceivedEventArgs* args) {
  ComPtr<ICoreWebView2WebMessageReceivedEventArgs2> args2;
  if (FAILED(args->QueryInterface(IID_PPV_ARGS(&args2)))) return;
  ComPtr<ICoreWebView2ObjectCollectionView> objects;
  if (FAILED(args2->get_AdditionalObjects(&objects)) || !objects) return;
  UINT32 count = 0;
  objects->get_Count(&count);
  for (UINT32 i = 0; i < count; ++i) {
    ComPtr<IUnknown> obj;
    if (FAILED(objects->GetValueAtIndex(i, &obj)) || !obj) continue;
    ComPtr<ICoreWebView2File> file;
    if (FAILED(obj.As(&file))) continue;
    LPWSTR p = nullptr;
    if (SUCCEEDED(file->get_Path(&p)) && p) {
      PostOpen(p);
      CoTaskMemFree(p);
      break;
    }
  }
}

// ───────────────────────── 页面消息 ─────────────────────────
void OnWebMessage(ICoreWebView2WebMessageReceivedEventArgs* args) {
  LPWSTR raw = nullptr;
  if (FAILED(args->TryGetWebMessageAsString(&raw)) || !raw) return;
  std::wstring msg = raw;
  CoTaskMemFree(raw);
  std::vector<std::wstring> parts = Split(msg, L'\x1f');
  const std::wstring& cmd = parts[0];
  auto arg = [&parts](size_t i) -> const std::wstring& {
    static const std::wstring empty;
    return i < parts.size() ? parts[i] : empty;
  };

  if (cmd == L"ready") SendInit();
  else if (cmd == L"save-state") { if (!arg(1).empty()) QueueSave(ToUtf8(arg(1))); }
  else if (cmd == L"open-dialog") ShowOpenDialog();
  else if (cmd == L"open-dropped") HandleDroppedFiles(args);
  else if (cmd == L"open-external") OpenExternal(arg(1));
  else if (cmd == L"reveal") RevealInExplorer(arg(1));
  else if (cmd == L"set-title") SetWindowTextW(g_hwnd, arg(1).empty() ? kAppName : arg(1).c_str());
  else if (cmd == L"set-theme") SetTheme(arg(1), arg(2), arg(3) == L"1");
  else if (cmd == L"watch") StartWatch(arg(1));
  else if (cmd == L"fullscreen") ToggleFullscreen();
  else if (cmd == L"list-fonts") SendFontList();
  else if (cmd == L"save-text") SaveTextDialog(arg(1), arg(2));
  else if (cmd == L"devtools") { if (g_webview) g_webview->OpenDevToolsWindow(); }
  else if (cmd == L"open-data-dir") ShellExecuteW(g_hwnd, L"open", g_dataDir.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
}

// ───────────────────────── 资源与本地文件通道 ─────────────────────────
// 内嵌资源表：路径 → 资源编号
const std::unordered_map<std::wstring, int>& EmbeddedIndex() {
  static std::unordered_map<std::wstring, int> index = [] {
    std::unordered_map<std::wstring, int> m;
    for (const auto& f : kEmbeddedWebFiles) m.emplace(f.path, f.id);
    return m;
  }();
  return index;
}

bool LoadAppResource(const std::wstring& rel, std::string& out) {
  if (rel.find(L"..") != std::wstring::npos) return false;
  if (!g_devWebDir.empty()) {
    std::wstring p = rel;
    std::replace(p.begin(), p.end(), L'/', L'\\');
    return ReadAllBytes(g_devWebDir + L"\\" + p, out);
  }
  auto it = EmbeddedIndex().find(rel);
  if (it == EmbeddedIndex().end()) return false;
  HRSRC res = FindResourceW(g_inst, MAKEINTRESOURCEW(it->second), RT_RCDATA);
  if (!res) return false;
  HGLOBAL mem = LoadResource(g_inst, res);
  DWORD size = SizeofResource(g_inst, res);
  const char* ptr = static_cast<const char*>(LockResource(mem));
  if (!ptr) return false;
  out.assign(ptr, size);
  return true;
}

void OnWebResourceRequested(ICoreWebView2WebResourceRequestedEventArgs* args) {
  ComPtr<ICoreWebView2WebResourceRequest> req;
  if (FAILED(args->get_Request(&req))) return;
  LPWSTR uriRaw = nullptr;
  if (FAILED(req->get_Uri(&uriRaw)) || !uriRaw) return;
  std::wstring uri = uriRaw;
  CoTaskMemFree(uriRaw);
  if (!StartsWith(ToLower(uri.substr(0, wcslen(kOrigin))), kOrigin)) return;

  std::wstring path = uri.substr(wcslen(kOrigin));
  size_t cut = path.find_first_of(L"?#");
  if (cut != std::wstring::npos) path.resize(cut);
  if (path.empty()) path = L"index.html";

  std::string body;
  std::wstring mime;
  bool found = false;
  bool noStore = false;
  if (StartsWith(path, L"@fs/")) {
    // 本地文件通道：/@fs/D:/目录/文件.md
    std::wstring file = PercentDecode(path.substr(4));
    std::replace(file.begin(), file.end(), L'/', L'\\');
    if (file.size() > 2 && file[1] == L':') {
      file = FullPath(file);
      found = ReadAllBytes(file, body);
    } else if (StartsWith(file, L"\\\\")) {
      found = ReadAllBytes(file, body);
    }
    mime = MimeFor(file);
    noStore = true;
  } else {
    std::wstring rel = PercentDecode(path);
    found = LoadAppResource(rel, body);
    mime = MimeFor(rel);
    noStore = !g_devWebDir.empty();
  }

  ComPtr<ICoreWebView2WebResourceResponse> resp;
  if (found) {
    ComPtr<IStream> stream;
    stream.Attach(SHCreateMemStream(reinterpret_cast<const BYTE*>(body.data()), static_cast<UINT>(body.size())));
    std::wstring headers = L"Content-Type: " + mime + L"\r\nCache-Control: " + (noStore ? L"no-store" : L"no-cache") +
                           L"\r\nX-Content-Type-Options: nosniff";
    g_env->CreateWebResourceResponse(stream.Get(), 200, L"OK", headers.c_str(), &resp);
  } else {
    g_env->CreateWebResourceResponse(nullptr, 404, L"Not Found", L"Content-Type: text/plain", &resp);
  }
  if (resp) args->put_Response(resp.Get());
}

// ───────────────────────── 关闭流程 ─────────────────────────
void FinishClose() {
  if (g_closeFinished) return;
  g_closeFinished = true;
  KillTimer(g_hwnd, kTimerCloseTimeout);
  DestroyWindow(g_hwnd);
}

// 关闭窗口前，先向页面索取包含最新阅读位置的完整状态，交给写盘线程后再销毁窗口
void BeginClose() {
  g_closing = true;
  SetTimer(g_hwnd, kTimerCloseTimeout, 1500, nullptr);
  HRESULT hr = g_webview->ExecuteScript(
      L"(function(){try{return window.__mdreaderFlush?window.__mdreaderFlush():null}catch(e){return null}})()",
      Callback<ICoreWebView2ExecuteScriptCompletedHandler>([](HRESULT errorCode, LPCWSTR result) -> HRESULT {
        if (SUCCEEDED(errorCode) && result) {
          std::wstring state;
          if (JsonUnquote(result, state) && state.size() > 2) QueueSave(ToUtf8(state));
        }
        FinishClose();
        return S_OK;
      }).Get());
  if (FAILED(hr)) FinishClose();
}

// ───────────────────────── 内嵌浏览器初始化 ─────────────────────────
void ResizeWebView() {
  if (!g_controller) return;
  RECT rc;
  GetClientRect(g_hwnd, &rc);
  g_controller->put_Bounds(rc);
}

void ConfigureSettings() {
  ComPtr<ICoreWebView2Settings> s;
  if (FAILED(g_webview->get_Settings(&s))) return;
  s->put_IsStatusBarEnabled(FALSE);
  s->put_AreDefaultContextMenusEnabled(FALSE);  // 使用页面自己的右键菜单
  s->put_IsZoomControlEnabled(FALSE);           // 缩放由阅读器的字号设置接管
  s->put_AreDevToolsEnabled(TRUE);
  s->put_IsBuiltInErrorPageEnabled(TRUE);
  ComPtr<ICoreWebView2Settings3> s3;
  if (SUCCEEDED(s.As(&s3))) s3->put_AreBrowserAcceleratorKeysEnabled(FALSE);  // 防止 F5、Ctrl+R 刷新整个界面
  ComPtr<ICoreWebView2Settings4> s4;
  if (SUCCEEDED(s.As(&s4))) {
    s4->put_IsPasswordAutosaveEnabled(FALSE);
    s4->put_IsGeneralAutofillEnabled(FALSE);
  }
  ComPtr<ICoreWebView2Settings5> s5;
  if (SUCCEEDED(s.As(&s5))) s5->put_IsPinchZoomEnabled(FALSE);
  ComPtr<ICoreWebView2Settings6> s6;
  if (SUCCEEDED(s.As(&s6))) s6->put_IsSwipeNavigationEnabled(FALSE);  // 触控板横滑不会“后退”离开阅读界面
  ComPtr<ICoreWebView2Settings8> s8;
  if (SUCCEEDED(s.As(&s8))) s8->put_IsReputationCheckingRequired(FALSE);
}

HRESULT OnControllerCreated(HRESULT result, ICoreWebView2Controller* controller) {
  if (FAILED(result) || !controller) {
    wchar_t msg[256];
    swprintf_s(msg, L"无法创建页面视图（错误码 0x%08X）。", static_cast<unsigned>(result));
    MessageBoxW(g_hwnd, msg, kAppName, MB_ICONERROR);
    return S_OK;
  }
  g_controller = controller;
  g_controller->get_CoreWebView2(&g_webview);
  ApplyWindowColors();
  ConfigureSettings();

  EventRegistrationToken token;
  g_webview->AddWebResourceRequestedFilter(L"https://app.local/*", COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
  g_webview->add_WebResourceRequested(
      Callback<ICoreWebView2WebResourceRequestedEventHandler>(
          [](ICoreWebView2*, ICoreWebView2WebResourceRequestedEventArgs* args) -> HRESULT {
            OnWebResourceRequested(args);
            return S_OK;
          }).Get(),
      &token);

  g_webview->add_WebMessageReceived(
      Callback<ICoreWebView2WebMessageReceivedEventHandler>(
          [](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* args) -> HRESULT {
            OnWebMessage(args);
            return S_OK;
          }).Get(),
      &token);

  // 只允许在应用自身页面内导航；外部链接交给系统浏览器
  g_webview->add_NavigationStarting(
      Callback<ICoreWebView2NavigationStartingEventHandler>(
          [](ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* args) -> HRESULT {
            LPWSTR uri = nullptr;
            if (SUCCEEDED(args->get_Uri(&uri)) && uri) {
              std::wstring u = uri;
              CoTaskMemFree(uri);
              if (!StartsWith(ToLower(u), kOrigin)) {
                args->put_Cancel(TRUE);
                OpenExternal(u);
              }
            }
            return S_OK;
          }).Get(),
      &token);

  g_webview->add_NewWindowRequested(
      Callback<ICoreWebView2NewWindowRequestedEventHandler>(
          [](ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* args) -> HRESULT {
            args->put_Handled(TRUE);
            LPWSTR uri = nullptr;
            if (SUCCEEDED(args->get_Uri(&uri)) && uri) {
              OpenExternal(uri);
              CoTaskMemFree(uri);
            }
            return S_OK;
          }).Get(),
      &token);

  // 拒绝定位、通知等一切权限请求
  g_webview->add_PermissionRequested(
      Callback<ICoreWebView2PermissionRequestedEventHandler>(
          [](ICoreWebView2*, ICoreWebView2PermissionRequestedEventArgs* args) -> HRESULT {
            COREWEBVIEW2_PERMISSION_KIND kind;
            args->get_PermissionKind(&kind);
            args->put_State(kind == COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ ? COREWEBVIEW2_PERMISSION_STATE_ALLOW
                                                                                : COREWEBVIEW2_PERMISSION_STATE_DENY);
            return S_OK;
          }).Get(),
      &token);

  // 页面进程意外退出时自动重新载入（阅读进度早已写盘，重新载入后会回到原位）
  g_webview->add_ProcessFailed(
      Callback<ICoreWebView2ProcessFailedEventHandler>(
          [](ICoreWebView2*, ICoreWebView2ProcessFailedEventArgs* args) -> HRESULT {
            COREWEBVIEW2_PROCESS_FAILED_KIND kind;
            args->get_ProcessFailedKind(&kind);
            if (kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED ||
                kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE) {
              g_pageReady = false;
              g_pendingOpen = g_watchPath;  // 重新载入后继续打开当前文档
              if (g_webview) g_webview->Reload();
            }
            return S_OK;
          }).Get(),
      &token);

  ResizeWebView();
  g_controller->put_IsVisible(TRUE);
  g_webview->Navigate(L"https://app.local/index.html");
  if (GetForegroundWindow() == g_hwnd) g_controller->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
  return S_OK;
}

void CreateWebView() {
  HRESULT hr = CreateCoreWebView2EnvironmentWithOptions(
      nullptr, g_cacheDir.c_str(), nullptr,
      Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
          [](HRESULT result, ICoreWebView2Environment* env) -> HRESULT {
            if (FAILED(result) || !env) {
              int r = MessageBoxW(g_hwnd,
                                  L"未能启动页面渲染组件。\n\n墨阅依赖系统自带的 Microsoft Edge WebView2 运行时，"
                                  L"Windows 10/11 通常已预装。\n是否打开下载页面进行安装？",
                                  kAppName, MB_ICONWARNING | MB_YESNO);
              if (r == IDYES) ShellExecuteW(nullptr, L"open", L"https://go.microsoft.com/fwlink/p/?LinkId=2124703", nullptr, nullptr, SW_SHOWNORMAL);
              PostMessageW(g_hwnd, WM_CLOSE, 0, 0);
              return S_OK;
            }
            g_env = env;
            return env->CreateCoreWebView2Controller(
                g_hwnd, Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                            [](HRESULT r, ICoreWebView2Controller* c) -> HRESULT { return OnControllerCreated(r, c); })
                            .Get());
          }).Get());
  if (FAILED(hr)) {
    MessageBoxW(g_hwnd, L"未找到 Microsoft Edge WebView2 运行时，请安装后重试。", kAppName, MB_ICONERROR);
    PostMessageW(g_hwnd, WM_CLOSE, 0, 0);
  }
}

// ───────────────────────── 窗口过程 ─────────────────────────
LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  switch (msg) {
    case WM_SIZE:
      ResizeWebView();
      return 0;
    case WM_MOVE:
    case WM_MOVING:
      if (g_controller) g_controller->NotifyParentWindowPositionChanged();
      break;
    case WM_ACTIVATE:
      if (LOWORD(wp) != WA_INACTIVE && g_controller) g_controller->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
      break;
    case WM_DPICHANGED: {
      const RECT* r = reinterpret_cast<const RECT*>(lp);
      SetWindowPos(hwnd, nullptr, r->left, r->top, r->right - r->left, r->bottom - r->top, SWP_NOZORDER | SWP_NOACTIVATE);
      return 0;
    }
    case WM_GETMINMAXINFO: {
      UINT dpi = GetDpiForWindow(hwnd);
      auto* mmi = reinterpret_cast<MINMAXINFO*>(lp);
      mmi->ptMinTrackSize.x = MulDiv(480, static_cast<int>(dpi ? dpi : 96), 96);
      mmi->ptMinTrackSize.y = MulDiv(360, static_cast<int>(dpi ? dpi : 96), 96);
      return 0;
    }
    case WM_COPYDATA: {
      // 另一个实例转交过来的文件路径
      const auto* cds = reinterpret_cast<const COPYDATASTRUCT*>(lp);
      if (cds && cds->dwData == kCopyDataOpen && cds->lpData) {
        std::wstring path(static_cast<const wchar_t*>(cds->lpData), cds->cbData / sizeof(wchar_t));
        while (!path.empty() && path.back() == L'\0') path.pop_back();
        if (!path.empty()) PostOpen(path);
      }
      ActivateMainWindow();
      return TRUE;
    }
    case WM_TIMER:
      if (wp == kTimerWatch) CheckWatch();
      else if (wp == kTimerCloseTimeout) FinishClose();
      return 0;
    case WM_CLOSE:
      if (!g_closing && g_webview && g_pageReady) {
        BeginClose();
        return 0;
      }
      if (g_closing && !g_closeFinished) return 0;  // 正在等待页面交出最新状态
      break;
    case WM_ENDSESSION:
      // 注销或关机：确保已排队的状态写入磁盘
      if (wp) StopSaver();
      return 0;
    case WM_DESTROY:
      SaveWindowPlacement();
      KillTimer(hwnd, kTimerWatch);
      PostQuitMessage(0);
      return 0;
    default:
      break;
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

// ───────────────────────── 单实例 ─────────────────────────
// 已有窗口在运行时，把文件交给它并返回 true
bool ForwardToRunningInstance(const std::wstring& path) {
  HWND other = nullptr;
  for (int i = 0; i < 30 && !other; ++i) {
    other = FindWindowW(kWindowClass, nullptr);
    if (!other) Sleep(100);  // 对方可能刚启动，窗口尚未创建
  }
  if (!other) return false;
  DWORD pid = 0;
  GetWindowThreadProcessId(other, &pid);
  AllowSetForegroundWindow(pid);
  COPYDATASTRUCT cds{};
  cds.dwData = kCopyDataOpen;
  cds.cbData = static_cast<DWORD>((path.size() + 1) * sizeof(wchar_t));
  cds.lpData = const_cast<wchar_t*>(path.c_str());
  DWORD_PTR result = 0;
  SendMessageTimeoutW(other, WM_COPYDATA, 0, reinterpret_cast<LPARAM>(&cds), SMTO_ABORTIFHUNG, 3000, &result);
  return true;
}

void ParseCommandLine(std::wstring& openPath) {
  int argc = 0;
  LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  if (!argv) return;
  for (int i = 1; i < argc; ++i) {
    std::wstring a = argv[i];
    if (StartsWith(a, L"--dev-web=")) g_devWebDir = FullPath(a.substr(10));
    else if (StartsWith(a, L"--")) continue;
    else if (openPath.empty()) openPath = FullPath(a);
  }
  LocalFree(argv);
}

}  // namespace

int WINAPI wWinMain(HINSTANCE hInstance, HINSTANCE, LPWSTR, int nCmdShow) {
  g_inst = hInstance;
  std::wstring openPath;
  ParseCommandLine(openPath);

  // 单实例：已有窗口时转交文件后退出
  HANDLE mutex = CreateMutexW(nullptr, TRUE, kMutexName);
  if (mutex && GetLastError() == ERROR_ALREADY_EXISTS) {
    if (ForwardToRunningInstance(openPath)) {
      CloseHandle(mutex);
      return 0;
    }
  }

  CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  InitPaths();
  LoadThemeFromIni();
  g_pendingOpen = openPath;
  g_saveThread = std::thread(SaverLoop);

  WNDCLASSEXW wc = {sizeof(wc)};
  wc.style = CS_HREDRAW | CS_VREDRAW;
  wc.lpfnWndProc = WndProc;
  wc.hInstance = hInstance;
  wc.hIcon = LoadIconW(hInstance, MAKEINTRESOURCEW(IDI_APP));
  wc.hIconSm = static_cast<HICON>(LoadImageW(hInstance, MAKEINTRESOURCEW(IDI_APP), IMAGE_ICON, GetSystemMetrics(SM_CXSMICON),
                                             GetSystemMetrics(SM_CYSMICON), LR_DEFAULTCOLOR));
  wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  g_bgBrush = CreateSolidBrush(g_bgColor);
  wc.hbrBackground = g_bgBrush;
  wc.lpszClassName = kWindowClass;
  RegisterClassExW(&wc);

  g_hwnd = CreateWindowExW(0, kWindowClass, kAppName, WS_OVERLAPPEDWINDOW, CW_USEDEFAULT, CW_USEDEFAULT, 1280, 860, nullptr,
                           nullptr, hInstance, nullptr);
  if (!g_hwnd) return 1;
  ApplyWindowColors();
  RestoreWindowPlacement(nCmdShow);
  UpdateWindow(g_hwnd);
  CreateWebView();

  MSG m;
  while (GetMessageW(&m, nullptr, 0, 0) > 0) {
    TranslateMessage(&m);
    DispatchMessageW(&m);
  }

  StopSaver();  // 写完最后一份状态再退出
  if (g_controller) g_controller->Close();
  g_webview.Reset();
  g_controller.Reset();
  g_env.Reset();
  CoUninitialize();
  if (mutex) CloseHandle(mutex);
  return 0;
}
