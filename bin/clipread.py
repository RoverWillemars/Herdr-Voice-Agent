#!/usr/bin/env python3
"""Prints {"primary": ..., "clipboard": ...} as JSON. Run with GDK_BACKEND=x11 so GTK reads
through Xwayland without needing a focused window."""
import json
import gi

gi.require_version("Gdk", "3.0")
gi.require_version("Gtk", "3.0")
from gi.repository import Gdk, Gtk  # noqa: E402

out = {}
for name, sel in (("primary", Gdk.SELECTION_PRIMARY), ("clipboard", Gdk.SELECTION_CLIPBOARD)):
    out[name] = Gtk.Clipboard.get(sel).wait_for_text() or ""
print(json.dumps(out))
