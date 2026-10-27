using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Windows.Forms;
using System.Reflection;

[assembly: AssemblyTitle("NodeScope")]
[assembly: AssemblyProduct("NodeScope")]
[assembly: AssemblyDescription("Local proxy connection diagnostics")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string script = Path.Combine(root, "server.cjs");
        string log = Path.Combine(root, "data", "launcher.log");
        if (!File.Exists(script))
        {
            ShowError("没有找到程序文件 server.cjs。请完整解压 NodeScope 文件夹后再打开。", null);
            return 1;
        }
        string node = Path.Combine(root, "runtime", "node.exe");
        if (!File.Exists(node)) node = Path.Combine(root, "runtime", "bin", "node.exe");
        if (!File.Exists(node)) node = "node.exe";
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(log));
            using (StreamWriter writer = new StreamWriter(new FileStream(log, FileMode.Append, FileAccess.Write, FileShare.ReadWrite), new UTF8Encoding(false)))
            using (Process process = new Process())
            {
                object gate = new object();
                writer.WriteLine("NodeScope launcher - " + DateTimeOffset.Now.ToString("o"));
                writer.Flush();
                process.StartInfo = new ProcessStartInfo
                {
                    FileName = node,
                    Arguments = "\"" + script + "\" --desktop",
                    WorkingDirectory = root,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8
                };
                DataReceivedEventHandler writeLine = delegate(object sender, DataReceivedEventArgs ev)
                {
                    if (ev.Data == null) return;
                    lock (gate)
                    {
                        writer.WriteLine(ev.Data);
                        writer.Flush();
                    }
                };
                process.OutputDataReceived += writeLine;
                process.ErrorDataReceived += writeLine;
                process.Start();
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                process.WaitForExit();
                if (process.ExitCode == 0) return 0;
                ShowError("NodeScope 启动失败或意外退出。请查看日志中的具体原因。", log);
                return process.ExitCode;
            }
        }
        catch (Exception ex)
        {
            ShowError("无法启动 NodeScope。请使用完整的便携版，或安装 Node.js 22 及以上版本。\n\n" + ex.Message, File.Exists(log) ? log : null);
            return 1;
        }
    }
    private static void ShowError(string message, string log)
    {
        if (log != null) message += "\n\n日志：" + log;
        MessageBox.Show(message, "NodeScope · 节点观测台", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }
}


