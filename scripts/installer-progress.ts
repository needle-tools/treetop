import { mkdtemp, writeFile, rm, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InstallerControl } from "./windows-installer-core";

/** Compiled on the Mac build machine; end users need no Swift tools. */
export const macInstallerWindowSource = String.raw`
import AppKit
import Darwin

final class InstallerWindow: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let env = ProcessInfo.processInfo.environment
    var window: NSWindow!
    var status: NSTextField!
    var progress: NSProgressIndicator!
    var timer: Timer?
    var canCancel = true
    var cancelled = false
    var done = false
    func write(_ text: String, _ key: String) {
        if let path = env[key] { try? Data(text.utf8).write(to: URL(fileURLWithPath: path), options: .atomic) }
    }
    func cancel() {
        guard canCancel && !cancelled else { return }
        cancelled = true
        status.stringValue = "Cancelling installation\u{2026}"
        window.standardWindowButton(.closeButton)?.isEnabled = false
        write("cancel", "TREETOP_SETUP_CANCEL")
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool { cancel(); return false }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if done { return .terminateNow }; cancel(); return .terminateCancel
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 440),
                          styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Treetop installer"
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.backgroundColor = NSColor(calibratedRed: 0.969, green: 0.965, blue: 0.945, alpha: 1)
        let image = NSImageView(frame: NSRect(x: 0, y: 126, width: 560, height: 314))
        image.imageScaling = .scaleProportionallyUpOrDown
        if let path = env["TREETOP_SETUP_SPLASH"] { image.image = NSImage(contentsOfFile: path) }
        window.contentView!.addSubview(image)
        let title = NSTextField(labelWithString: "Setting up Treetop")
        title.font = .systemFont(ofSize: 21, weight: .semibold)
        title.textColor = NSColor(calibratedRed: 0.14, green: 0.21, blue: 0.16, alpha: 1)
        title.frame = NSRect(x: 26, y: 80, width: 508, height: 28)
        window.contentView!.addSubview(title)
        status = NSTextField(wrappingLabelWithString: "Preparing the installer\u{2026}")
        status.font = .systemFont(ofSize: 13)
        status.textColor = .secondaryLabelColor
        status.frame = NSRect(x: 26, y: 34, width: 508, height: 40)
        window.contentView!.addSubview(status)
        progress = NSProgressIndicator(frame: NSRect(x: 26, y: 18, width: 508, height: 8))
        progress.isIndeterminate = false
        progress.minValue = 0; progress.maxValue = 100
        window.contentView!.addSubview(progress)
        window.center(); window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        write("ready", "TREETOP_SETUP_READY")
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.tick() }
    }
    func tick() {
        if let owner = env["TREETOP_SETUP_OWNER"], let pid = Int32(owner), kill(pid, 0) != 0 && errno == ESRCH {
            done = true; NSApp.terminate(nil); return
        }
        guard let path = env["TREETOP_SETUP_STATUS"], let data = FileManager.default.contents(atPath: path),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        done = json["done"] as? Bool ?? false
        canCancel = json["canCancel"] as? Bool ?? false
        if !cancelled || done { status.stringValue = json["message"] as? String ?? "" }
        progress.doubleValue = json["progress"] as? Double ?? 0
        window.standardWindowButton(.closeButton)?.isEnabled = canCancel && !cancelled
        if done { timer?.invalidate(); NSApp.terminate(nil) }
    }
}
let app = NSApplication.shared
let delegate = InstallerWindow()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
`;

// The window is a separate native UI process: extraction and hashing cannot
// freeze its close button. The status/cancel protocol is platform-independent.
const windowsWindow = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
[xml]$markup = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
 xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" Title="Treetop installer"
 Width="560" Height="440" WindowStartupLocation="CenterScreen" ResizeMode="NoResize"
 WindowStyle="None" AllowsTransparency="True" Background="Transparent" FontFamily="Segoe UI">
 <Border CornerRadius="14" Background="#F7F6F1" BorderBrush="#506052" BorderThickness="1">
  <Grid>
   <Grid.Clip><RectangleGeometry Rect="0,0,558,438" RadiusX="13" RadiusY="13"/></Grid.Clip>
   <Grid.RowDefinitions><RowDefinition Height="314"/><RowDefinition Height="*"/></Grid.RowDefinitions>
   <Image x:Name="Splash" Stretch="UniformToFill"/>
   <Button x:Name="Cancel" Content="&#xD7;" Width="32" Height="32" Margin="0,14,14,0"
    HorizontalAlignment="Right" VerticalAlignment="Top" Foreground="White" Background="#C02A332C"
    BorderThickness="0" FontSize="23" ToolTip="Cancel installation" AutomationProperties.Name="Cancel installation">
    <Button.Template><ControlTemplate TargetType="Button"><Border Background="{TemplateBinding Background}" CornerRadius="16">
     <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center" Margin="0,-3,0,0"/>
    </Border><ControlTemplate.Triggers><Trigger Property="IsMouseOver" Value="True"><Setter Property="Background" Value="#ED26372A"/></Trigger>
     <Trigger Property="IsEnabled" Value="False"><Setter Property="Opacity" Value="0.35"/></Trigger>
    </ControlTemplate.Triggers></ControlTemplate></Button.Template>
   </Button>
   <Grid Grid.Row="1" Margin="26,17,26,20">
    <Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition Height="*"/><RowDefinition Height="4"/></Grid.RowDefinitions>
    <TextBlock Text="Setting up Treetop" Foreground="#24352A" FontSize="21" FontWeight="SemiBold"/>
    <TextBlock x:Name="Status" Grid.Row="1" Text="Preparing the installer…" Foreground="#536058" FontSize="13"
     Margin="0,7,0,10" TextWrapping="Wrap" AutomationProperties.LiveSetting="Polite"/>
    <ProgressBar x:Name="Progress" Grid.Row="2" Minimum="0" Maximum="100" Value="0"
     Foreground="#52714B" Background="#E0E5DA" BorderThickness="0"/>
   </Grid>
  </Grid>
 </Border>
</Window>
'@
$reader = New-Object System.Xml.XmlNodeReader $markup
$window = [Windows.Markup.XamlReader]::Load($reader)
$status = $window.FindName('Status'); $progress = $window.FindName('Progress'); $cancel = $window.FindName('Cancel')
$image = New-Object Windows.Media.Imaging.BitmapImage
$image.BeginInit(); $image.CacheOption = 'OnLoad'; $image.UriSource = New-Object Uri $env:TREETOP_SETUP_SPLASH; $image.EndInit(); $image.Freeze()
$window.FindName('Splash').Source = $image
$script:allowClose = $false; $script:canCancel = $true; $script:cancelRequested = $false
function Request-Cancel {
 if (-not $script:canCancel -or $script:cancelRequested) { return }
 $script:cancelRequested = $true; $cancel.IsEnabled = $false
 $status.Text = 'Cancelling installation…'
 [IO.File]::WriteAllText($env:TREETOP_SETUP_CANCEL, 'cancel')
}
$cancel.Add_Click({ Request-Cancel })
$window.Add_Closing({ param($sender, $eventArgs) if (-not $script:allowClose) { $eventArgs.Cancel = $true; Request-Cancel } })
$window.Add_KeyDown({ if ($_.Key -eq 'Escape') { Request-Cancel; $_.Handled = $true } })
$window.Add_MouseLeftButtonDown({ if ($_.OriginalSource -isnot [Windows.Controls.Button]) { $window.DragMove() } })
$window.Add_ContentRendered({ [IO.File]::WriteAllText($env:TREETOP_SETUP_READY, 'ready') })
$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(100)
$timer.Add_Tick({
 try {
  $snapshot = [IO.File]::ReadAllText($env:TREETOP_SETUP_STATUS) | ConvertFrom-Json
  if (-not $script:cancelRequested -or $snapshot.done) { $status.Text = $snapshot.message }
  $progress.Value = $snapshot.progress
  $script:canCancel = $snapshot.canCancel; $cancel.IsEnabled = $script:canCancel -and -not $script:cancelRequested
  if ($snapshot.done) { $script:allowClose = $true; $window.Close() }
 } catch { }
 try { $null = [Diagnostics.Process]::GetProcessById([int]$env:TREETOP_SETUP_OWNER) }
 catch { $script:allowClose = $true; $window.Close() }
})
$timer.Start()
try { $null = $window.ShowDialog() } finally { $timer.Stop() }
`;

export interface InstallerProgressWindow {
  update(message: string, progress: number): Promise<void>;
  close(): Promise<void>;
}

/** WPF on Windows and a bundled Cocoa helper on macOS share this protocol. */
export async function openInstallerProgress(splash: string, control: InstallerControl, macHelper?: string): Promise<InstallerProgressWindow> {
  if (process.platform !== "win32" && process.platform !== "darwin") throw new Error("Unsupported installer window platform");
  if (process.platform === "darwin" && !macHelper) throw new Error("The macOS installer window helper is missing");
  const root = await mkdtemp(join(tmpdir(), "treetop-setup-ui-"));
  const status = join(root, "status.json"), cancel = join(root, "cancel"), ready = join(root, "ready");
  const script = join(root, "window.ps1"), image = join(root, "splash.png");
  let message = "Preparing the installer…", progress = 0;
  const publish = (done = false) => writeFile(status, JSON.stringify({ message, progress, canCancel: control.canCancel, done }));
  await Promise.all([writeFile(script, "\ufeff" + windowsWindow, "utf8"), Bun.write(image, Bun.file(splash)), publish()]);
  let args = ["powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", script];
  if (process.platform === "darwin") {
    const executable = join(root, "installer-window");
    await Bun.write(executable, Bun.file(macHelper!));
    await chmod(executable, 0o755);
    args = [executable];
  }
  const child = Bun.spawn(args, {
    windowsHide: true, stdin: "ignore", stdout: "ignore", stderr: "pipe",
    env: { ...process.env, TREETOP_SETUP_SPLASH: image, TREETOP_SETUP_STATUS: status, TREETOP_SETUP_CANCEL: cancel,
      TREETOP_SETUP_READY: ready, TREETOP_SETUP_OWNER: String(process.pid) },
  });
  const errors = new Response(child.stderr).text();
  const timer = setInterval(() => { if (existsSync(cancel)) control.cancel(); }, 100);
  timer.unref();
  const close = async () => {
    clearInterval(timer);
    await publish(true);
    const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(3000).then(() => false)]);
    if (!exited) { child.kill(); await child.exited; }
    await errors;
    await rm(root, { recursive: true, force: true });
  };
  try {
    const deadline = Date.now() + 15_000;
    while (!existsSync(ready)) {
      if (child.exitCode !== null) throw Error(`Could not open installer window: ${await errors}`);
      if (Date.now() > deadline) throw Error("Installer window did not open within 15 seconds");
      await Bun.sleep(50);
    }
  } catch (error) { await close(); throw error; }
  return {
    update: async (text, value) => {
      if (child.exitCode !== null) control.cancel();
      message = text; progress = value; await publish();
    },
    close,
  };
}
