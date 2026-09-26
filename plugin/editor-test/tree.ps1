# Helpers for the editor's AML trees (TreeViewItems named after their view model; the label is a Text child).
. "$PSScriptRoot\uia.ps1"
$ErrorActionPreference = 'Continue'
$Walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

function Label($item) {
  $c = $Walker.GetFirstChild($item)
  while ($c) { if ($c.Current.ControlType.ProgrammaticName -eq 'ControlType.Text' -and $c.Current.Name) { return $c.Current.Name }; $c = $Walker.GetNextSibling($c) }
  return ''
}

function TreeChildren($item) {
  $out = @(); $c = $Walker.GetFirstChild($item)
  while ($c) { if ($c.Current.ControlType.ProgrammaticName -eq 'ControlType.TreeItem') { $out += $c }; $c = $Walker.GetNextSibling($c) }
  return $out
}

# The tree item in the InstanceHierarchy pane whose label is the given text.
function IhRoot($w) {
  $pane = $w.FindFirst($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, '83FB269F-4012-4DF4-B188-FFAA4FBCD8BD')))
  foreach ($t in $pane.FindAll($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, 'TreeViewItem')))) { return $t }
}

# Walks a path of labels from the IH root, expanding on the way; returns the last item.
function TreePath($w, [string[]]$labels) {
  $item = IhRoot $w
  foreach ($l in $labels) {
    $ec = Get-Pattern $item ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
    if ($ec -and $ec.Current.ExpandCollapseState -ne 'Expanded') { $ec.Expand(); Start-Sleep -Milliseconds 400 }
    $next = TreeChildren $item | Where-Object { (Label $_) -eq $l } | Select-Object -First 1
    if (-not $next) { throw "no '$l' below '$(Label $item)'; children: " + ((TreeChildren $item | ForEach-Object { Label $_ }) -join ', ') }
    $item = $next
  }
  return $item
}

function SelectedLabel($w) {
  $pane = $w.FindFirst($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, '83FB269F-4012-4DF4-B188-FFAA4FBCD8BD')))
  foreach ($t in $pane.FindAll($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, 'TreeViewItem')))) {
    $s = Get-Pattern $t ([System.Windows.Automation.SelectionItemPattern]::Pattern)
    if ($s -and $s.Current.IsSelected) { return Label $t }
  }
  return ''
}

# Evaluates an expression in the viewer page (see cdp.mjs).
function Page([string]$expr) { & node "$PSScriptRoot\cdp.mjs" $expr }
