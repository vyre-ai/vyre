// vyre-sandbox.exe: runs one command line inside a named AppContainer, in a kill-on-close job object (the Windows sandbox for
// the local runner; core/runner/sandbox-win.js builds the calls). Compiled with the csc that ships in every Windows
// (C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe), so nothing is installed.
//
//   vyre-sandbox prepare <name> [--grant <path>=<RX|M>]... [--traverse <folder>]... [--exempt]   make the container, give it the folders, allow loopback
//   vyre-sandbox run <name> <cwd> -- <command line>                      run it with this process's stdin, stdout and stderr
//   vyre-sandbox cleanup <name> [--folder <path>]... [--tree <path>]...      take every right it was given off those folders (and trees), drop the exemption, delete it
//   vyre-sandbox delete <name>                                           remove the container
//
// The child gets only the three standard handles (an explicit handle list), the environment this process was started with,
// and the container's own token: it can read and write only what the container was granted. Network: nothing, except
// loopback when the container is exempt (a per-container switch that needs administrator, set once by `prepare --exempt`).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class VyreSandbox {
  [StructLayout(LayoutKind.Sequential)] struct SECURITY_CAPABILITIES { public IntPtr AppContainerSid; public IntPtr Capabilities; public uint CapabilityCount; public uint Reserved; }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFO { public int cb; public string lpReserved, lpDesktop, lpTitle; public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION Basic; public IO_COUNTERS Io; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }

  [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int CreateAppContainerProfile(string name, string display, string desc, IntPtr caps, uint count, out IntPtr sid);
  [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
  [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] static extern bool ConvertSidToStringSid(IntPtr sid, out string s);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr value, IntPtr size, IntPtr prev, IntPtr ret);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll")] static extern IntPtr CreateJobObject(IntPtr a, string name);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int cls, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int len);
  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll")] static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);

  static string ContainerSid(string name, bool create) {
    IntPtr sid = IntPtr.Zero; int hr = create ? CreateAppContainerProfile(name, name, "vyre local runner", IntPtr.Zero, 0, out sid) : 1;
    if (hr != 0) { hr = DeriveAppContainerSidFromAppContainerName(name, out sid); if (hr != 0) throw new Exception("no container " + name + " (hr " + hr + ")"); }
    string s; ConvertSidToStringSid(sid, out s); return s;
  }
  static int Exec(string file, string args) {
    var p = Process.Start(new ProcessStartInfo(file, args) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true });
    p.StandardOutput.ReadToEnd(); p.StandardError.ReadToEnd(); p.WaitForExit(); return p.ExitCode;
  }

  public static int Main(string[] a) {
    try {
      if (a.Length < 2) { Console.Error.WriteLine("usage: prepare|run|delete <name> ..."); return 2; }
      string verb = a[0], name = a[1];
      if (verb == "delete") { DeleteAppContainerProfile(name); return 0; }
      if (verb == "cleanup") {
        // Undo prepare: take the container's rights off every folder it was given or let through, drop the loopback exemption, delete the container.
        string sid0 = ContainerSid(name, false);
        for (int i = 2; i < a.Length; i++) {
          if (a[i] == "--folder" && i + 1 < a.Length) Exec("icacls.exe", "\"" + a[++i] + "\" /remove:g \"*" + sid0 + "\" /C /Q");        // just that folder (the ones above the workspace)
          else if (a[i] == "--tree" && i + 1 < a.Length) Exec("icacls.exe", "\"" + a[++i] + "\" /remove:g \"*" + sid0 + "\" /T /C /Q");  // a folder and everything under it
        }
        Exec("CheckNetIsolation.exe", "LoopbackExempt -d -p=" + sid0);
        DeleteAppContainerProfile(name);
        Console.WriteLine("cleaned sid=" + sid0);
        return 0;
      }
      if (verb == "prepare") {
        string sid = ContainerSid(name, true);
        bool exempt = false;
        for (int i = 2; i < a.Length; i++) {
          if (a[i] == "--grant" && i + 1 < a.Length) { var kv = a[++i].Split(new[] { '=' }, 2); Exec("icacls.exe", "\"" + kv[0] + "\" /grant \"*" + sid + ":(OI)(CI)" + kv[1] + "\" /T /C /Q"); }
          else if (a[i] == "--traverse" && i + 1 < a.Length) { Exec("icacls.exe", "\"" + a[++i] + "\" /grant \"*" + sid + ":(X)\" /C /Q"); }   // folder only, no inheritance: lets the container walk through it
          else if (a[i] == "--exempt") exempt = Exec("CheckNetIsolation.exe", "LoopbackExempt -a -p=" + sid) == 0;
        }
        Console.WriteLine("sid=" + sid + " exempt=" + (exempt ? "yes" : "no"));
        return 0;
      }
      if (verb == "run") {
        int dash = Array.IndexOf(a, "--");
        if (a.Length < 4 || dash < 0 || dash + 1 >= a.Length) { Console.Error.WriteLine("usage: run <name> <cwd> -- <command line>"); return 2; }
        string cwd = a[2], cmdline = string.Join(" ", a, dash + 1, a.Length - dash - 1);
        ContainerSid(name, false);
        IntPtr sid; DeriveAppContainerSidFromAppContainerName(name, out sid);
        var caps = new SECURITY_CAPABILITIES { AppContainerSid = sid };
        IntPtr capPtr = Marshal.AllocHGlobal(Marshal.SizeOf(caps)); Marshal.StructureToPtr(caps, capPtr, false);
        IntPtr hin = GetStdHandle(-10), hout = GetStdHandle(-11), herr = GetStdHandle(-12);
        foreach (var h in new[] { hin, hout, herr }) SetHandleInformation(h, 1, 1);
        IntPtr hl = Marshal.AllocHGlobal(IntPtr.Size * 3); Marshal.WriteIntPtr(hl, 0, hin); Marshal.WriteIntPtr(hl, IntPtr.Size, hout); Marshal.WriteIntPtr(hl, IntPtr.Size * 2, herr);
        IntPtr size = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
        IntPtr list = Marshal.AllocHGlobal(size);
        if (!InitializeProcThreadAttributeList(list, 2, 0, ref size)) throw new Exception("init attr " + Marshal.GetLastWin32Error());
        if (!UpdateProcThreadAttribute(list, 0, (IntPtr)0x20009, capPtr, (IntPtr)Marshal.SizeOf(caps), IntPtr.Zero, IntPtr.Zero)) throw new Exception("capabilities " + Marshal.GetLastWin32Error());
        if (!UpdateProcThreadAttribute(list, 0, (IntPtr)0x20002, hl, (IntPtr)(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero)) throw new Exception("handle list " + Marshal.GetLastWin32Error());
        var si = new STARTUPINFOEX(); si.StartupInfo.cb = Marshal.SizeOf(si); si.lpAttributeList = list;
        si.StartupInfo.dwFlags = 0x100; si.StartupInfo.hStdInput = hin; si.StartupInfo.hStdOutput = hout; si.StartupInfo.hStdError = herr;
        PROCESS_INFORMATION pi;
        // CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW: the job holds it before its first instruction.
        if (!CreateProcessW(null, new StringBuilder(cmdline), IntPtr.Zero, IntPtr.Zero, true, 0x4u | 0x80000u | 0x08000000u, IntPtr.Zero, cwd, ref si, out pi)) throw new Exception("CreateProcess " + Marshal.GetLastWin32Error());
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        var lim = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION(); lim.Basic.LimitFlags = 0x2000; // kill on close
        SetInformationJobObject(job, 9, ref lim, Marshal.SizeOf(lim));
        AssignProcessToJobObject(job, pi.hProcess);
        ResumeThread(pi.hThread);
        WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
        uint code; GetExitCodeProcess(pi.hProcess, out code); return (int)code;
      }
      Console.Error.WriteLine("unknown verb " + verb); return 2;
    } catch (Exception e) { Console.Error.WriteLine("vyre-sandbox: " + e.Message); return 1; }
  }
}
