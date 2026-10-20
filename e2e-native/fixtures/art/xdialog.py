"""Answer the app's native GTK file dialog under Xvfb with XTEST key events.

WebDriver cannot reach the GTK FileChooser that tauri-plugin-dialog opens
(rfd, GTK3 backend), so the art specs drive it the way a keyboard user would:

  python3 -I xdialog.py save /abs/path/file.pdf   type a full path in Name, Enter
  python3 -I xdialog.py open /abs/path/image.png  Ctrl+L, type the path, Enter
  python3 -I xdialog.py cancel                    Escape

It waits for a new viewable top-level window whose title is not the main
"MXTP MKR" window, focuses it, then sends the keys. Stdlib only (ctypes on
libX11 + libXtst, both already pulled in by WebKitGTK).
"""

import ctypes
import sys
import time

xlib = ctypes.cdll.LoadLibrary("libX11.so.6")
xtst = ctypes.cdll.LoadLibrary("libXtst.so.6")

Display_p = ctypes.c_void_p
Window = ctypes.c_ulong

xlib.XOpenDisplay.restype = Display_p
xlib.XOpenDisplay.argtypes = [ctypes.c_char_p]
xlib.XDefaultRootWindow.restype = Window
xlib.XDefaultRootWindow.argtypes = [Display_p]
xlib.XQueryTree.argtypes = [
    Display_p,
    Window,
    ctypes.POINTER(Window),
    ctypes.POINTER(Window),
    ctypes.POINTER(ctypes.POINTER(Window)),
    ctypes.POINTER(ctypes.c_uint),
]
xlib.XFetchName.argtypes = [Display_p, Window, ctypes.POINTER(ctypes.c_char_p)]
xlib.XFree.argtypes = [ctypes.c_void_p]
xlib.XSetInputFocus.argtypes = [Display_p, Window, ctypes.c_int, ctypes.c_ulong]
xlib.XRaiseWindow.argtypes = [Display_p, Window]
xlib.XSync.argtypes = [Display_p, ctypes.c_int]
xlib.XFlush.argtypes = [Display_p]
xlib.XKeysymToKeycode.restype = ctypes.c_ubyte
xlib.XKeysymToKeycode.argtypes = [Display_p, ctypes.c_ulong]
xlib.XKeycodeToKeysym.restype = ctypes.c_ulong
xlib.XKeycodeToKeysym.argtypes = [Display_p, ctypes.c_ubyte, ctypes.c_int]
xlib.XWarpPointer.argtypes = [
    Display_p,
    Window,
    Window,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_uint,
    ctypes.c_uint,
    ctypes.c_int,
    ctypes.c_int,
]
xtst.XTestFakeKeyEvent.argtypes = [Display_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]


class XWindowAttributes(ctypes.Structure):
    _fields_ = [
        ("x", ctypes.c_int),
        ("y", ctypes.c_int),
        ("width", ctypes.c_int),
        ("height", ctypes.c_int),
        ("border_width", ctypes.c_int),
        ("depth", ctypes.c_int),
        ("visual", ctypes.c_void_p),
        ("root", Window),
        ("class_", ctypes.c_int),
        ("bit_gravity", ctypes.c_int),
        ("win_gravity", ctypes.c_int),
        ("backing_store", ctypes.c_int),
        ("backing_planes", ctypes.c_ulong),
        ("backing_pixel", ctypes.c_ulong),
        ("save_under", ctypes.c_int),
        ("colormap", ctypes.c_ulong),
        ("map_installed", ctypes.c_int),
        ("map_state", ctypes.c_int),
        ("all_event_masks", ctypes.c_long),
        ("your_event_mask", ctypes.c_long),
        ("do_not_propagate_mask", ctypes.c_long),
        ("override_redirect", ctypes.c_int),
        ("screen", ctypes.c_void_p),
    ]


xlib.XGetWindowAttributes.argtypes = [Display_p, Window, ctypes.POINTER(XWindowAttributes)]

IS_VIEWABLE = 2
REVERT_TO_PARENT = 2
KEYSYMS = {
    "Return": 0xFF0D,
    "Escape": 0xFF1B,
    "BackSpace": 0xFF08,
    "Control_L": 0xFFE3,
    "Shift_L": 0xFFE1,
}


def toplevels(dpy):
    root = xlib.XDefaultRootWindow(dpy)
    root_ret, parent_ret = Window(), Window()
    children = ctypes.POINTER(Window)()
    count = ctypes.c_uint()
    if not xlib.XQueryTree(dpy, root, ctypes.byref(root_ret), ctypes.byref(parent_ret), ctypes.byref(children), ctypes.byref(count)):
        return []
    found = []
    for index in range(count.value):
        window = children[index]
        attrs = XWindowAttributes()
        if not xlib.XGetWindowAttributes(dpy, window, ctypes.byref(attrs)):
            continue
        if attrs.map_state != IS_VIEWABLE or attrs.override_redirect:
            continue
        name = ctypes.c_char_p()
        title = ""
        if xlib.XFetchName(dpy, window, ctypes.byref(name)) and name.value:
            title = name.value.decode("latin1")
            xlib.XFree(name)
        found.append((window, title, attrs.width, attrs.height))
    if children:
        xlib.XFree(children)
    return found


def wait_for_dialog(dpy, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        for window, title, width, height in toplevels(dpy):
            if title and title != "MXTP MKR":
                return window, title, width, height
        time.sleep(0.1)
    seen = [(title, width, height) for _, title, width, height in toplevels(dpy)]
    raise SystemExit(f"no file dialog appeared within {timeout}s; viewable top-levels: {seen}")


def key(dpy, keysym, modifiers=()):
    code = xlib.XKeysymToKeycode(dpy, keysym)
    if not code:
        raise SystemExit(f"no keycode for keysym {keysym:#x}")
    mods = list(modifiers)
    if xlib.XKeycodeToKeysym(dpy, code, 0) != keysym and xlib.XKeycodeToKeysym(dpy, code, 1) == keysym:
        mods.append(KEYSYMS["Shift_L"])
    mod_codes = [xlib.XKeysymToKeycode(dpy, mod) for mod in mods]
    for mod in mod_codes:
        xtst.XTestFakeKeyEvent(dpy, mod, 1, 0)
    xtst.XTestFakeKeyEvent(dpy, code, 1, 0)
    xtst.XTestFakeKeyEvent(dpy, code, 0, 0)
    for mod in reversed(mod_codes):
        xtst.XTestFakeKeyEvent(dpy, mod, 0, 0)
    xlib.XSync(dpy, 0)
    time.sleep(0.02)


def type_text(dpy, text):
    for char in text:
        key(dpy, ord(char))


def main():
    mode = sys.argv[1]
    target = sys.argv[2] if len(sys.argv) > 2 else ""
    dpy = xlib.XOpenDisplay(None)
    if not dpy:
        raise SystemExit("cannot open X display (DISPLAY unset?)")
    window, title, width, height = wait_for_dialog(dpy, 30)
    # Give GTK a moment to finish laying out and focusing the Name entry.
    time.sleep(1.0)
    xlib.XRaiseWindow(dpy, window)
    xlib.XWarpPointer(dpy, 0, window, 0, 0, 0, 0, max(1, width // 2), max(1, height // 2))
    xlib.XSetInputFocus(dpy, window, REVERT_TO_PARENT, 0)
    xlib.XSync(dpy, 0)
    time.sleep(0.3)
    if mode == "cancel":
        key(dpy, KEYSYMS["Escape"])
    elif mode == "save":
        key(dpy, ord("a"), [KEYSYMS["Control_L"]])
        key(dpy, KEYSYMS["BackSpace"])
        type_text(dpy, target)
        time.sleep(0.3)
        key(dpy, KEYSYMS["Return"])
    elif mode == "open":
        key(dpy, ord("l"), [KEYSYMS["Control_L"]])
        time.sleep(0.3)
        type_text(dpy, target)
        time.sleep(0.5)
        key(dpy, KEYSYMS["Return"])
    else:
        raise SystemExit(f"unknown mode {mode}")
    print(f"answered '{title}' ({width}x{height}) with {mode} {target}")


if __name__ == "__main__":
    main()
