using System;
using System.Diagnostics;
using System.IO;

class MSP {
    static void Main() {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        Directory.SetCurrentDirectory(dir);

        string nodeExe = Path.Combine(dir, "node.exe");
        string appJs = Path.Combine(dir, "resources", "app", "app.js");

        if (!File.Exists(nodeExe)) {
            Console.WriteLine("Brak node.exe");
            return;
        }
        if (!File.Exists(appJs)) {
            Console.WriteLine("Brak resources/app/app.js");
            return;
        }

        var psi = new ProcessStartInfo(nodeExe, "\"" + appJs + "\"") {
            WorkingDirectory = dir,
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        Process node;
        try {
            node = Process.Start(psi);
        } catch (Exception ex) {
            Console.WriteLine("Nie udalo sie uruchomic node: " + ex.Message);
            return;
        }

        node.WaitForExit();
    }
}