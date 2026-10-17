"""任务独占的系统进程容器，不影响应用或其他任务。"""

import ctypes
import subprocess


PROCESS_QUERY_TIMEOUT_SECONDS = 1
WINDOWS_JOB_EXTENDED_LIMIT_INFORMATION = 9
WINDOWS_JOB_ACCOUNTING_INFORMATION = 1
WINDOWS_JOB_KILL_ON_CLOSE = 0x00002000
WINDOWS_PROCESS_TERMINATE = 0x0001
WINDOWS_PROCESS_SET_QUOTA = 0x0100
WINDOWS_SNAPSHOT_THREADS = 0x00000004
WINDOWS_CREATE_SUSPENDED = 0x00000004
WINDOWS_THREAD_SUSPEND_RESUME = 0x0002
WINDOWS_DWORD_FAILURE = 0xFFFFFFFF


def resume_suspended_process(process_id: int) -> None:
    """先把挂起进程放入 Job，再执行入口，避免后代在分配 Job 前逃逸。"""
    from ctypes import wintypes

    class ThreadEntry(ctypes.Structure):
        _fields_ = [
            ("size", wintypes.DWORD),
            ("usage", wintypes.DWORD),
            ("thread_id", wintypes.DWORD),
            ("owner_process_id", wintypes.DWORD),
            ("base_priority", wintypes.LONG),
            ("delta_priority", wintypes.LONG),
            ("flags", wintypes.DWORD),
        ]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel.Thread32First.argtypes = [wintypes.HANDLE, ctypes.POINTER(ThreadEntry)]
    kernel.Thread32Next.argtypes = [wintypes.HANDLE, ctypes.POINTER(ThreadEntry)]
    kernel.OpenThread.restype = wintypes.HANDLE
    kernel.OpenThread.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.ResumeThread.restype = wintypes.DWORD
    kernel.ResumeThread.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    snapshot = kernel.CreateToolhelp32Snapshot(WINDOWS_SNAPSHOT_THREADS, 0)
    if snapshot == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    resumed = False
    try:
        entry = ThreadEntry()
        entry.size = ctypes.sizeof(entry)
        available = kernel.Thread32First(snapshot, ctypes.byref(entry))
        while available:
            if entry.owner_process_id == process_id:
                thread = kernel.OpenThread(
                    WINDOWS_THREAD_SUSPEND_RESUME, False, entry.thread_id
                )
                if not thread:
                    raise ctypes.WinError(ctypes.get_last_error())
                try:
                    previous_count = kernel.ResumeThread(thread)
                    if previous_count == WINDOWS_DWORD_FAILURE:
                        raise ctypes.WinError(ctypes.get_last_error())
                    resumed = resumed or previous_count > 0
                finally:
                    kernel.CloseHandle(thread)
            available = kernel.Thread32Next(snapshot, ctypes.byref(entry))
        if not resumed:
            raise OSError("未找到可恢复的挂起任务线程")
    finally:
        kernel.CloseHandle(snapshot)


def process_group_is_running(process_group_id: int) -> bool:
    """已退出但尚未被系统回收的孙进程不再持有文件或执行模型。"""
    result = subprocess.run(
        ["ps", "-axo", "pgid=,stat="],
        capture_output=True,
        text=True,
        check=True,
        timeout=PROCESS_QUERY_TIMEOUT_SECONDS,
    )
    for line in result.stdout.splitlines():
        fields = line.split()
        if (
            len(fields) == 2
            and fields[0] == str(process_group_id)
            and not fields[1].startswith("Z")
        ):
            return True
    return False


class WindowsProcessJob:
    """Windows Job Object 自动收拢任务子进程，关闭句柄时整棵树退出。"""

    def __init__(self, process_id: int):
        from ctypes import wintypes

        class BasicLimits(ctypes.Structure):
            _fields_ = [
                ("process_time", ctypes.c_longlong),
                ("job_time", ctypes.c_longlong),
                ("flags", wintypes.DWORD),
                ("minimum_working_set", ctypes.c_size_t),
                ("maximum_working_set", ctypes.c_size_t),
                ("active_process_limit", wintypes.DWORD),
                ("affinity", ctypes.c_size_t),
                ("priority", wintypes.DWORD),
                ("scheduling", wintypes.DWORD),
            ]

        class IoCounters(ctypes.Structure):
            _fields_ = [
                (name, ctypes.c_ulonglong)
                for name in (
                    "read_operations",
                    "write_operations",
                    "other_operations",
                    "read_bytes",
                    "write_bytes",
                    "other_bytes",
                )
            ]

        class ExtendedLimits(ctypes.Structure):
            _fields_ = [
                ("basic", BasicLimits),
                ("io", IoCounters),
                ("process_memory", ctypes.c_size_t),
                ("job_memory", ctypes.c_size_t),
                ("peak_process_memory", ctypes.c_size_t),
                ("peak_job_memory", ctypes.c_size_t),
            ]

        self._kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self._kernel.CreateJobObjectW.restype = wintypes.HANDLE
        self._kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        self._kernel.OpenProcess.restype = wintypes.HANDLE
        self._kernel.OpenProcess.argtypes = [
            wintypes.DWORD,
            wintypes.BOOL,
            wintypes.DWORD,
        ]
        self._kernel.SetInformationJobObject.argtypes = [
            wintypes.HANDLE,
            ctypes.c_int,
            ctypes.c_void_p,
            wintypes.DWORD,
        ]
        self._kernel.AssignProcessToJobObject.argtypes = [
            wintypes.HANDLE,
            wintypes.HANDLE,
        ]
        self._kernel.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
        self._kernel.QueryInformationJobObject.argtypes = [
            wintypes.HANDLE,
            ctypes.c_int,
            ctypes.c_void_p,
            wintypes.DWORD,
            ctypes.c_void_p,
        ]
        self._kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self._handle = self._kernel.CreateJobObjectW(None, None)
        if not self._handle:
            raise ctypes.WinError(ctypes.get_last_error())
        process_handle = self._kernel.OpenProcess(
            WINDOWS_PROCESS_TERMINATE | WINDOWS_PROCESS_SET_QUOTA, False, process_id
        )
        try:
            limits = ExtendedLimits()
            limits.basic.flags = WINDOWS_JOB_KILL_ON_CLOSE
            if not self._kernel.SetInformationJobObject(
                self._handle,
                WINDOWS_JOB_EXTENDED_LIMIT_INFORMATION,
                ctypes.byref(limits),
                ctypes.sizeof(limits),
            ):
                raise ctypes.WinError(ctypes.get_last_error())
            if not process_handle or not self._kernel.AssignProcessToJobObject(
                self._handle, process_handle
            ):
                raise ctypes.WinError(ctypes.get_last_error())
        except BaseException:
            self.close()
            raise
        finally:
            if process_handle:
                self._kernel.CloseHandle(process_handle)

    def terminate(self) -> None:
        if not self._kernel.TerminateJobObject(self._handle, 1):
            raise ctypes.WinError(ctypes.get_last_error())

    def is_running(self) -> bool:
        class Accounting(ctypes.Structure):
            _fields_ = [
                ("user_time", ctypes.c_longlong),
                ("kernel_time", ctypes.c_longlong),
                ("period_user_time", ctypes.c_longlong),
                ("period_kernel_time", ctypes.c_longlong),
                ("page_faults", ctypes.c_ulong),
                ("total_processes", ctypes.c_ulong),
                ("active_processes", ctypes.c_ulong),
                ("terminated_processes", ctypes.c_ulong),
            ]

        accounting = Accounting()
        if not self._kernel.QueryInformationJobObject(
            self._handle,
            WINDOWS_JOB_ACCOUNTING_INFORMATION,
            ctypes.byref(accounting),
            ctypes.sizeof(accounting),
            None,
        ):
            raise ctypes.WinError(ctypes.get_last_error())
        return accounting.active_processes > 0

    def close(self) -> None:
        if self._handle:
            self._kernel.CloseHandle(self._handle)
            self._handle = None
