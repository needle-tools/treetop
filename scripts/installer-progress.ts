import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InstallerControl } from "./windows-installer-core";

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

/** Windows' built-in WPF supplies the GUI without a browser/runtime install.
 * A macOS native frontend can consume the same status/cancel protocol. */
export async function openInstallerProgress(splash: string, control: InstallerControl): Promise<InstallerProgressWindow> {
  if (process.platform !== "win32") throw new Error("The native installer window requires a platform adapter");
  const root = await mkdtemp(join(tmpdir(), "treetop-setup-ui-"));
  const status = join(root, "status.json"), cancel = join(root, "cancel"), ready = join(root, "ready");
  const script = join(root, "window.ps1"), image = join(root, "splash.png");
  let message = "Preparing the installer…", progress = 0;
  const publish = (done = false) => writeFile(status, JSON.stringify({ message, progress, canCancel: control.canCancel, done }));
  await Promise.all([writeFile(script, "\ufeff" + windowsWindow, "utf8"), Bun.write(image, Bun.file(splash)), publish()]);
  const child = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", script], {
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
