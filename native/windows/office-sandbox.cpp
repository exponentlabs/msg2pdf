// A small, dependency-free AppContainer broker for optional LibreOffice jobs.
// No network capabilities, a bounded Job Object, and a private writable workspace.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <userenv.h>
#include <aclapi.h>
#include <sddl.h>
#include <iostream>
#include <string>
#include <vector>
#pragma comment(lib, "userenv.lib")
#pragma comment(lib, "advapi32.lib")

class Handle {
 public:
  HANDLE value = nullptr;
  explicit Handle(HANDLE handle = nullptr) : value(handle) {}
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
};
std::wstring quote(const std::wstring& value) {
  std::wstring output = L"\"";
  size_t slashes = 0;
  for (wchar_t c : value) {
    if (c == L'\\') { ++slashes; continue; }
    output.append(slashes * (c == L'\"' ? 2 : 1), L'\\');
    slashes = 0;
    if (c == L'\"') output += L'\\';
    output += c;
  }
  output.append(slashes * 2, L'\\');
  return output + L'\"';
}
bool grantWorkspace(const std::wstring& workspace, PSID sid) {
  EXPLICIT_ACCESSW access{};
  access.grfAccessPermissions = FILE_ALL_ACCESS;
  access.grfAccessMode = GRANT_ACCESS;
  access.grfInheritance = SUB_CONTAINERS_AND_OBJECTS_INHERIT;
  access.Trustee.TrusteeForm = TRUSTEE_IS_SID;
  access.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
  access.Trustee.ptstrName = static_cast<LPWSTR>(sid);
  PACL existing = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  DWORD result = GetNamedSecurityInfoW(workspace.c_str(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                                      nullptr, nullptr, &existing, nullptr, &descriptor);
  if (result != ERROR_SUCCESS) return false;
  PACL updated = nullptr;
  result = SetEntriesInAclW(1, &access, existing, &updated);
  if (result == ERROR_SUCCESS) result = SetNamedSecurityInfoW(const_cast<LPWSTR>(workspace.c_str()),
      SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, updated, nullptr);
  if (updated) LocalFree(updated);
  LocalFree(descriptor);
  return result == ERROR_SUCCESS;
}
int wmain(int argc, wchar_t* argv[]) {
  if (argc < 3) { std::cerr << "Expected workspace and LibreOffice executable\n"; return 2; }
  const std::wstring workspace = argv[1];
  const std::wstring executable = argv[2];
  const std::wstring profile = L"msg2pdf.office." + std::to_wstring(GetCurrentProcessId()) + L"." + std::to_wstring(GetTickCount64());
  PSID sid = nullptr;
  HRESULT result = CreateAppContainerProfile(profile.c_str(), L"msg2pdf Office worker",
      L"Isolated local document conversion", nullptr, 0, &sid);
  if (FAILED(result)) { std::cerr << "Cannot create Windows AppContainer: " << result << '\n'; return 1; }
  auto cleanup = [&]() { if (sid) FreeSid(sid); DeleteAppContainerProfile(profile.c_str()); };
  if (!grantWorkspace(workspace, sid)) { std::cerr << "Cannot grant the sandbox its private workspace\n"; cleanup(); return 1; }
  SIZE_T bytes = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &bytes);
  std::vector<BYTE> attributes(bytes);
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = static_cast<DWORD>(sizeof(startup));
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.StartupInfo.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  startup.StartupInfo.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  startup.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.data());
  if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &bytes)) { cleanup(); return 1; }
  SECURITY_CAPABILITIES capabilities{};
  capabilities.AppContainerSid = sid; // Deliberately no network or other capabilities.
  if (!UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
                                 &capabilities, sizeof(capabilities), nullptr, nullptr)) {
    DeleteProcThreadAttributeList(startup.lpAttributeList); cleanup(); return 1;
  }
  Handle job(CreateJobObjectW(nullptr, nullptr));
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE |
      JOB_OBJECT_LIMIT_JOB_MEMORY | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
  limits.BasicLimitInformation.ActiveProcessLimit = 32;
  limits.JobMemoryLimit = static_cast<SIZE_T>(1536) * 1024 * 1024;
  if (!job.value || !SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, static_cast<DWORD>(sizeof(limits)))) {
    DeleteProcThreadAttributeList(startup.lpAttributeList); cleanup(); return 1;
  }
  std::wstring command;
  for (int i = 2; i < argc; ++i) { if (!command.empty()) command += L' '; command += quote(argv[i]); }
  PROCESS_INFORMATION process{};
  BOOL created = CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, TRUE,
      EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr,
      workspace.c_str(), &startup.StartupInfo, &process);
  DeleteProcThreadAttributeList(startup.lpAttributeList);
  if (!created) {
    std::cerr << "Windows refused the isolated LibreOffice process (error " << GetLastError()
              << "). Install LibreOffice for all users in Program Files and try again.\n";
    cleanup(); return 1;
  }
  Handle processHandle(process.hProcess);
  Handle threadHandle(process.hThread);
  if (!AssignProcessToJobObject(job.value, processHandle.value)) {
    TerminateProcess(processHandle.value, 1); cleanup(); return 1;
  }
  if (ResumeThread(threadHandle.value) == static_cast<DWORD>(-1)) {
    TerminateJobObject(job.value, 1); cleanup(); return 1;
  }
  DWORD wait = WaitForSingleObject(processHandle.value, 120000);
  DWORD exitCode = 1;
  if (wait == WAIT_TIMEOUT) {
    TerminateJobObject(job.value, 124);
    WaitForSingleObject(processHandle.value, 3000);
    std::cerr << "Office conversion exceeded 120 seconds\n";
    exitCode = 124;
  } else if (wait == WAIT_OBJECT_0) GetExitCodeProcess(processHandle.value, &exitCode);
  TerminateJobObject(job.value, exitCode); // No surviving child processes.
  cleanup();
  return static_cast<int>(exitCode);
}
