from pathlib import Path


class DirectoryPickerError(RuntimeError):
    """系统无法提供目录对话框时，向本机 Web 界面返回可理解的失败原因。"""


def select_directory() -> str | None:
    """借助后端进程显示系统对话框，因为浏览器不会公开目录的绝对路径。"""
    try:
        import tkinter
        from tkinter import filedialog
    except ImportError as error:
        raise DirectoryPickerError("当前 Python 环境不支持系统文件夹选择器") from error

    try:
        root = tkinter.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        try:
            selected_path = filedialog.askdirectory(
                parent=root,
                mustexist=True,
                title="选择文件夹",
            )
        finally:
            root.destroy()
    except (OSError, tkinter.TclError) as error:
        raise DirectoryPickerError("无法打开系统文件夹选择器") from error

    if not selected_path:
        return None
    return str(Path(selected_path).resolve())
