// Cursor Usage HUD — floating overlay, polls official usage API every 60s.
// Target: .NET Framework 4.x (system) + winsqlite3.dll (system) → tiny single-file exe.
using System;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;

static class Native
{
    const int SQLITE_OPEN_READONLY = 1;
    const int SQLITE_ROW = 100;
    static readonly IntPtr SQLITE_TRANSIENT = new IntPtr(-1);

    [DllImport("winsqlite3", CallingConvention = CallingConvention.Cdecl)]
    static extern int sqlite3_open_v2(byte[] f, out IntPtr db, int flags, IntPtr vfs);

    [DllImport("winsqlite3", CallingConvention = CallingConvention.Cdecl)]
    static extern int sqlite3_close_v2(IntPtr db);

    [DllImport("winsqlite3", CallingConvention = CallingConvention.Cdecl)]
    static extern int sqlite3_prepare_v2(IntPtr db, byte[] sql, int n, out IntPtr stmt, IntPtr tail);

    [DllImport("winsqlite3", CallingConvention = CallingConvention.Cdecl)]
    static extern int sqlite3_bind_text(IntPtr stmt, int i, byte[] v, int n, IntPtr d);

    [DllImport("winsqlite3", CallingConvention = CallingConvention.Cdecl)]
    static extern int sqlite3_step(IntPtr stmt);

    [DllImport("winsqlite3", CallingConvention = CallingConvention.Cdecl)]
    static extern IntPtr sqlite3_column_text(IntPtr stmt, int i);

    [DllImport("winsqlite3", CallingConvention = CallingConvention.Cdecl)]
    static extern int sqlite3_finalize(IntPtr stmt);

    [DllImport("user32.dll")]
    public static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    public static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, IntPtr l);

    [DllImport("kernel32.dll")]
    public static extern bool AllocConsole();

    [DllImport("kernel32.dll")]
    public static extern bool AttachConsole(int pid);

    static byte[] Utf8Z(string s)
    {
        var b = Encoding.UTF8.GetBytes(s);
        var z = new byte[b.Length + 1];
        Buffer.BlockCopy(b, 0, z, 0, b.Length);
        return z;
    }

    static string PtrToUtf8(IntPtr p)
    {
        if (p == IntPtr.Zero) return "";
        int len = 0;
        while (Marshal.ReadByte(p, len) != 0) len++;
        if (len == 0) return "";
        var buf = new byte[len];
        Marshal.Copy(p, buf, 0, len);
        return Encoding.UTF8.GetString(buf);
    }

    public static string ReadItem(string dbPath, string key)
    {
        // Prefer a temp copy so a locked live DB still works.
        string path = dbPath;
        string tmp = null;
        try
        {
            tmp = Path.Combine(Path.GetTempPath(), "cuh-" + Guid.NewGuid().ToString("N") + ".vscdb");
            File.Copy(dbPath, tmp, true);
            var wal = dbPath + "-wal";
            var shm = dbPath + "-shm";
            if (File.Exists(wal)) File.Copy(wal, tmp + "-wal", true);
            if (File.Exists(shm)) File.Copy(shm, tmp + "-shm", true);
            path = tmp;
        }
        catch { path = dbPath; tmp = null; }

        IntPtr db;
        if (sqlite3_open_v2(Utf8Z(path), out db, SQLITE_OPEN_READONLY, IntPtr.Zero) != 0)
            throw new Exception("open db failed");

        try
        {
            IntPtr stmt;
            var sql = Utf8Z("SELECT value FROM ItemTable WHERE key=?");
            if (sqlite3_prepare_v2(db, sql, sql.Length, out stmt, IntPtr.Zero) != 0)
                throw new Exception("prepare failed");
            try
            {
                var kb = Encoding.UTF8.GetBytes(key);
                sqlite3_bind_text(stmt, 1, kb, kb.Length, SQLITE_TRANSIENT);
                if (sqlite3_step(stmt) != SQLITE_ROW) return "";
                return PtrToUtf8(sqlite3_column_text(stmt, 0));
            }
            finally { sqlite3_finalize(stmt); }
        }
        finally
        {
            sqlite3_close_v2(db);
            if (tmp != null)
            {
                try { File.Delete(tmp); } catch { }
                try { File.Delete(tmp + "-wal"); } catch { }
                try { File.Delete(tmp + "-shm"); } catch { }
            }
        }
    }
}

sealed class HudForm : Form
{
    readonly Label _user = new Label();
    readonly Label _plan = new Label();
    readonly Label _pct = new Label();
    readonly Label _msg = new Label();
    readonly Label _status = new Label();
    readonly ProgressBar _bar = new ProgressBar();
    readonly Timer _timer = new Timer();
    string _lastSub = "";
    string _db;

    public HudForm()
    {
        _db = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            @"Cursor\User\globalStorage\state.vscdb");

        Text = "Cursor Usage";
        FormBorderStyle = FormBorderStyle.None;
        TopMost = true;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        Location = new Point(Screen.PrimaryScreen.WorkingArea.Right - 300, 40);
        ClientSize = new Size(280, 92);
        BackColor = Color.FromArgb(28, 28, 30);
        ForeColor = Color.WhiteSmoke;
        Font = new Font("Segoe UI", 9f);
        Opacity = 0.94;
        Padding = new Padding(10);

        _user.AutoSize = false;
        _user.SetBounds(10, 8, 200, 18);
        _user.Font = new Font("Segoe UI", 9f, FontStyle.Bold);
        _user.ForeColor = Color.White;

        _plan.AutoSize = false;
        _plan.SetBounds(210, 8, 60, 18);
        _plan.TextAlign = ContentAlignment.MiddleRight;
        _plan.ForeColor = Color.FromArgb(160, 160, 165);

        _bar.SetBounds(10, 32, 200, 14);
        _bar.Minimum = 0;
        _bar.Maximum = 1000;
        _bar.Style = ProgressBarStyle.Continuous;

        _pct.AutoSize = false;
        _pct.SetBounds(214, 28, 56, 20);
        _pct.TextAlign = ContentAlignment.MiddleRight;
        _pct.Font = new Font("Segoe UI", 10f, FontStyle.Bold);

        _msg.AutoSize = false;
        _msg.SetBounds(10, 52, 260, 18);
        _msg.ForeColor = Color.FromArgb(180, 180, 185);

        _status.AutoSize = false;
        _status.SetBounds(10, 72, 260, 16);
        _status.ForeColor = Color.FromArgb(120, 120, 125);
        _status.Font = new Font("Segoe UI", 7.5f);

        Controls.AddRange(new Control[] { _user, _plan, _bar, _pct, _msg, _status });

        var menu = new ContextMenuStrip();
        menu.Items.Add("Refresh now", null, (s, e) => RefreshNow());
        menu.Items.Add("Exit", null, (s, e) => Close());
        ContextMenuStrip = menu;

        MouseDown += Drag;
        foreach (Control c in Controls) c.MouseDown += Drag;

        _timer.Interval = 60000;
        _timer.Tick += (s, e) => RefreshNow();
        Shown += (s, e) => { RefreshNow(); _timer.Start(); };
    }

    void Drag(object sender, MouseEventArgs e)
    {
        if (e.Button != MouseButtons.Left) return;
        Native.ReleaseCapture();
        Native.SendMessage(Handle, 0xA1, (IntPtr)0x2, IntPtr.Zero);
    }

    void RefreshNow()
    {
        try
        {
            if (!File.Exists(_db))
            {
                Fail("Cursor state.vscdb not found - sign in first");
                return;
            }

            var jwt = Native.ReadItem(_db, "cursorAuth/accessToken");
            if (string.IsNullOrWhiteSpace(jwt))
            {
                Fail("No accessToken — sign in to Cursor");
                return;
            }

            var email = Native.ReadItem(_db, "cursorAuth/cachedEmail");
            var membership = Native.ReadItem(_db, "cursorAuth/stripeMembershipType");
            var sub = JwtClaim(jwt, "sub");
            if (string.IsNullOrEmpty(email)) email = JwtClaim(jwt, "email");
            if (string.IsNullOrEmpty(email)) email = ShortSub(sub);

            var switched = !string.IsNullOrEmpty(sub) && _lastSub != "" && sub != _lastSub;
            _lastSub = sub ?? "";

            var json = PostUsage(jwt);
            var used = ParseDouble(json, "totalPercentUsed");
            var rem = Math.Max(0, Math.Min(100, 100.0 - used));
            var display = ExtractString(json, "displayMessage");
            if (string.IsNullOrEmpty(display))
                display = string.Format("Used {0:0.#}% · Remaining {1:0.#}%", used, rem);

            _user.Text = Truncate(email, 28);
            _plan.Text = string.IsNullOrEmpty(membership) ? "" : membership;
            _bar.Value = (int)Math.Round(rem * 10);
            _pct.Text = string.Format("{0:0.#}%", rem);
            _pct.ForeColor = rem <= 10 ? Color.Salmon : rem <= 30 ? Color.Gold : Color.FromArgb(120, 220, 140);
            _msg.Text = Truncate(display, 42);
            _status.Text = (switched ? "switched · " : "left=remaining · ")
                + "next @" + DateTime.Now.AddMinutes(1).ToString("HH:mm:ss");
        }
        catch (Exception ex)
        {
            Fail(ex.Message);
        }
    }

    void Fail(string msg)
    {
        _user.Text = "Cursor Usage";
        _plan.Text = "";
        _bar.Value = 0;
        _pct.Text = "—";
        _pct.ForeColor = Color.Salmon;
        _msg.Text = Truncate(msg, 42);
        _status.Text = DateTime.Now.ToString("HH:mm:ss");
    }

    internal static string PostUsage(string jwt)
    {
        var req = (HttpWebRequest)WebRequest.Create(
            "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage");
        req.Method = "POST";
        req.ContentType = "application/json";
        req.Headers["Authorization"] = "Bearer " + jwt;
        req.Timeout = 25000;
        var body = Encoding.UTF8.GetBytes("{}");
        req.ContentLength = body.Length;
        using (var s = req.GetRequestStream()) s.Write(body, 0, body.Length);
        using (var resp = (HttpWebResponse)req.GetResponse())
        using (var sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
            return sr.ReadToEnd();
    }

    static string JwtClaim(string jwt, string claim)
    {
        try
        {
            var parts = jwt.Split('.');
            if (parts.Length < 2) return "";
            var p = parts[1].Replace('-', '+').Replace('_', '/');
            switch (p.Length % 4) { case 2: p += "=="; break; case 3: p += "="; break; }
            var json = Encoding.UTF8.GetString(Convert.FromBase64String(p));
            return ExtractString(json, claim);
        }
        catch { return ""; }
    }

    static string ExtractString(string json, string key)
    {
        var m = Regex.Match(json, "\"" + Regex.Escape(key) + "\"\\s*:\\s*\"((?:\\\\.|[^\"\\\\])*)\"");
        if (!m.Success) return "";
        return Regex.Unescape(m.Groups[1].Value);
    }

    internal static double ParseDouble(string json, string key)
    {
        var m = Regex.Match(json, "\"" + Regex.Escape(key) + "\"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)");
        if (!m.Success) return 0;
        double v;
        return double.TryParse(m.Groups[1].Value,
            System.Globalization.NumberStyles.Float,
            System.Globalization.CultureInfo.InvariantCulture, out v) ? v : 0;
    }

    static string ShortSub(string sub)
    {
        if (string.IsNullOrEmpty(sub)) return "(unknown)";
        var i = sub.LastIndexOf('|');
        return i >= 0 ? sub.Substring(i + 1) : sub;
    }

    static string Truncate(string s, int n)
    {
        if (string.IsNullOrEmpty(s)) return "";
        return s.Length <= n ? s : s.Substring(0, n - 1) + "...";
    }
}

static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
        if (args.Length > 0 && string.Equals(args[0], "--once", StringComparison.OrdinalIgnoreCase))
        {
            RunOnce();
            return;
        }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new HudForm());
    }

    static void RunOnce()
    {
        Native.AttachConsole(-1);
        try
        {
            Console.SetOut(new StreamWriter(Console.OpenStandardOutput()) { AutoFlush = true });
            Console.SetError(new StreamWriter(Console.OpenStandardError()) { AutoFlush = true });
        }
        catch { }

        var db = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            @"Cursor\User\globalStorage\state.vscdb");
        try
        {
            var jwt = Native.ReadItem(db, "cursorAuth/accessToken");
            if (string.IsNullOrWhiteSpace(jwt)) throw new Exception("no accessToken");
            var email = Native.ReadItem(db, "cursorAuth/cachedEmail");
            var membership = Native.ReadItem(db, "cursorAuth/stripeMembershipType");
            var json = HudForm.PostUsage(jwt);
            var used = HudForm.ParseDouble(json, "totalPercentUsed");
            Console.WriteLine("email=" + email);
            Console.WriteLine("plan=" + membership);
            Console.WriteLine("used=" + used.ToString(System.Globalization.CultureInfo.InvariantCulture) + "%");
            Console.WriteLine("remaining=" + (100.0 - used).ToString(System.Globalization.CultureInfo.InvariantCulture) + "%");
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("ERROR: " + ex.Message);
            Environment.ExitCode = 1;
        }
    }
}
