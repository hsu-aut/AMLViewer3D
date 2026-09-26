# Real mouse clicks for what the editor only processes from the mouse (a selection in its
# trees). Windows does not let a background script bring the editor to the front, so a
# person clicks the editor's title bar once; Wait-Foreground waits for that. A click is
# made only while the editor is in front and the point is not covered by another window;
# the cursor goes back where it was.
if (-not ('Win32Input' -as [type])) {
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win32Input {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
}
"@ }

function Wait-Foreground($w, [int]$seconds = 240) {
  $h = [IntPtr]$w.Current.NativeWindowHandle
  $end = (Get-Date).AddSeconds($seconds)
  while ([Win32Input]::GetForegroundWindow() -ne $h -and (Get-Date) -lt $end) { Start-Sleep -Milliseconds 500 }
  return ([Win32Input]::GetForegroundWindow() -eq $h)
}

function Click-At($w, $el) {
  $h = [IntPtr]$w.Current.NativeWindowHandle
  if ([Win32Input]::GetForegroundWindow() -ne $h) { throw 'the editor is not in front; no click' }
  $r = $el.Current.BoundingRectangle
  if ($r.IsEmpty -or $r.Width -le 0) { throw 'the element has no area on screen (scroll it into view first)' }
  $p = New-Object Win32Input+POINT; $p.X = [int]($r.X + [Math]::Min(25, $r.Width / 2)); $p.Y = [int]($r.Y + $r.Height / 2)
  if ([Win32Input]::GetAncestor([Win32Input]::WindowFromPoint($p), 2) -ne $h) { throw "the point ($($p.X),$($p.Y)) is covered by another window" }
  $old = New-Object Win32Input+POINT; [void][Win32Input]::GetCursorPos([ref]$old)
  [void][Win32Input]::SetCursorPos($p.X, $p.Y); Start-Sleep -Milliseconds 80
  [Win32Input]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60
  [Win32Input]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 80
  [void][Win32Input]::SetCursorPos($old.X, $old.Y)
}
