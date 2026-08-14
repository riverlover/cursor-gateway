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
    const int SQLITE_OPEN_URI = 0x40;
    const int SQLITE_ROW = 100;
    static readonly IntPtr SQLITE_TRANSIENT = new IntPtr(-1);

    [DllImport("winsqlite3", CallingConvention = CallingConvention.Cdecl)]
    static extern int sqlite3_open_v2(byte[] f, out IntPtr db, int flags, IntPtr vfs);

    [DllImport("winsqlite3", CallingConvention = CallingConvention.Cdecl)]
    static extern int sqlite3_close_v2(IntPtr db);

    [DllImport("winsqlite3", CallingConvention = CallingConvention.Cdecl)]
    static extern int sqlite3_busy_timeout(IntPtr db, int ms);

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

    static string QueryItem(string path, string key, bool uri)
    {
        IntPtr db;
        var flags = SQLITE_OPEN_READONLY | (uri ? SQLITE_OPEN_URI : 0);
        var openPath = uri ? ("file:" + path.Replace('\\', '/') + "?mode=ro") : path;
        if (sqlite3_open_v2(Utf8Z(openPath), out db, flags, IntPtr.Zero) != 0)
            throw new Exception("open db failed");
        try
        {
            sqlite3_busy_timeout(db, 1500);
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
        finally { sqlite3_close_v2(db); }
    }

    public static string ReadItem(string dbPath, string key)
    {
        // Prefer live DB + WAL (avoids stale File.Copy snapshots).
        try { return QueryItem(dbPath, key, true); }
        catch { }

        string tmp = null;
        try
        {
            tmp = Path.Combine(Path.GetTempPath(), "cuh-" + Guid.NewGuid().ToString("N") + ".vscdb");
            File.Copy(dbPath, tmp, true);
            var wal = dbPath + "-wal";
            var shm = dbPath + "-shm";
            if (File.Exists(wal)) File.Copy(wal, tmp + "-wal", true);
            if (File.Exists(shm)) File.Copy(shm, tmp + "-shm", true);
            return QueryItem(tmp, key, false);
        }
        finally
        {
            if (tmp != null)
            {
                try { File.Delete(tmp); } catch { }
                try { File.Delete(tmp + "-wal"); } catch { }
                try { File.Delete(tmp + "-shm"); } catch { }
            }
        }
    }
}

/// <summary>
/// Auth: prefer AI助手/cursor-renewal seamless_state.json (操作面板账号),
/// else Cursor IDE state.vscdb.
/// </summary>
static class CursorAuth
{
    public const string SourceRenewal = "renewal";
    public const string SourceIde = "ide";

    public static string RenewalDir
    {
        get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".cursor-renewal"); }
    }

    public static string SeamlessPath
    {
        get { return Path.Combine(RenewalDir, "seamless_state.json"); }
    }

    public static string IdeDbPath
    {
        get
        {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                @"Cursor\User\globalStorage\state.vscdb");
        }
    }

    public struct Session
    {
        public string Jwt;
        public string Email;
        public string Membership;
        public string Source; // renewal | ide
    }

    public static Session Load()
    {
        Session s;
        s.Jwt = "";
        s.Email = "";
        s.Membership = "";
        s.Source = SourceIde;

        // 1) AI助手领号态 — matches 操作面板「当前账号」
        try
        {
            var path = SeamlessPath;
            if (File.Exists(path))
            {
                var json = File.ReadAllText(path, Encoding.UTF8);
                var jwt = ExtractJsonString(json, "accessToken");
                if (!string.IsNullOrWhiteSpace(jwt))
                {
                    s.Jwt = jwt.Trim();
                    s.Email = ExtractJsonString(json, "email");
                    s.Source = SourceRenewal;
                    // membership still from IDE cache if present (often stale; API overrides)
                    if (File.Exists(IdeDbPath))
                    {
                        try { s.Membership = Native.ReadItem(IdeDbPath, "cursorAuth/stripeMembershipType"); }
                        catch { }
                    }
                    return s;
                }
            }
        }
        catch { }

        // 2) Cursor IDE state.vscdb
        if (!File.Exists(IdeDbPath))
            throw new Exception("Cursor state.vscdb not found - sign in first");

        s.Jwt = Native.ReadItem(IdeDbPath, "cursorAuth/accessToken");
        if (string.IsNullOrWhiteSpace(s.Jwt))
            throw new Exception("No accessToken - sign in to Cursor");
        s.Email = Native.ReadItem(IdeDbPath, "cursorAuth/cachedEmail");
        s.Membership = Native.ReadItem(IdeDbPath, "cursorAuth/stripeMembershipType");
        s.Source = SourceIde;
        return s;
    }

    static string ExtractJsonString(string json, string key)
    {
        var m = Regex.Match(json, "\"" + Regex.Escape(key) + "\"\\s*:\\s*\"((?:\\\\.|[^\"\\\\])*)\"");
        if (!m.Success) return "";
        return Regex.Unescape(m.Groups[1].Value);
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
    readonly Button _refresh = new Button();
    readonly Timer _timer = new Timer();
    readonly Timer _debounce = new Timer();
    FileSystemWatcher _watchDb;
    FileSystemWatcher _watchRenewal;
    string _lastSub = "";
    bool _busy;

    public HudForm()
    {
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

        _user.AutoSize = false;
        _user.SetBounds(10, 8, 175, 18);
        _user.Font = new Font("Segoe UI", 9f, FontStyle.Bold);
        _user.ForeColor = Color.White;

        _plan.AutoSize = false;
        _plan.SetBounds(185, 8, 50, 18);
        _plan.TextAlign = ContentAlignment.MiddleRight;
        _plan.ForeColor = Color.FromArgb(160, 160, 165);

        _refresh.SetBounds(242, 5, 28, 22);
        _refresh.Text = "R";
        _refresh.FlatStyle = FlatStyle.Flat;
        _refresh.FlatAppearance.BorderSize = 0;
        _refresh.BackColor = Color.FromArgb(45, 45, 48);
        _refresh.ForeColor = Color.WhiteSmoke;
        _refresh.Font = new Font("Segoe UI", 9f, FontStyle.Bold);
        _refresh.FlatAppearance.MouseOverBackColor = Color.FromArgb(70, 70, 75);
        _refresh.Cursor = Cursors.Hand;
        _refresh.TabStop = false;
        _refresh.Click += (s, e) => ManualRefresh();

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

        Controls.AddRange(new Control[] { _user, _plan, _refresh, _bar, _pct, _msg, _status });

        var menu = new ContextMenuStrip();
        menu.Items.Add("Refresh now", null, (s, e) => ManualRefresh());
        menu.Items.Add("Exit", null, (s, e) => Close());
        ContextMenuStrip = menu;

        MouseDown += Drag;
        foreach (Control c in Controls)
        {
            if (c == _refresh) continue;
            c.MouseDown += Drag;
        }

        _timer.Interval = 60000;
        _timer.Tick += (s, e) => RefreshNow(false);

        _debounce.Interval = 800;
        _debounce.Tick += (s, e) => { _debounce.Stop(); RefreshNow(false); };

        Shown += (s, e) =>
        {
            StartWatch();
            RefreshNow(false);
            _timer.Start();
        };
        FormClosed += (s, e) =>
        {
            DisposeWatch(ref _watchDb);
            DisposeWatch(ref _watchRenewal);
        };
    }

    static void DisposeWatch(ref FileSystemWatcher w)
    {
        if (w == null) return;
        try { w.EnableRaisingEvents = false; w.Dispose(); } catch { }
        w = null;
    }

    void StartWatch()
    {
        FileSystemEventHandler bump = (s, e) =>
        {
            try { BeginInvoke(new Action(() => { _debounce.Stop(); _debounce.Start(); })); }
            catch { }
        };

        try
        {
            var dbDir = Path.GetDirectoryName(CursorAuth.IdeDbPath);
            if (!string.IsNullOrEmpty(dbDir) && Directory.Exists(dbDir))
            {
                _watchDb = new FileSystemWatcher(dbDir);
                _watchDb.Filter = "state.vscdb*";
                _watchDb.NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.Size | NotifyFilters.FileName;
                _watchDb.Changed += bump;
                _watchDb.Created += bump;
                _watchDb.Renamed += (s, e) => bump(s, e);
                _watchDb.EnableRaisingEvents = true;
            }
        }
        catch { }

        try
        {
            var renewalDir = CursorAuth.RenewalDir;
            if (Directory.Exists(renewalDir))
            {
                _watchRenewal = new FileSystemWatcher(renewalDir);
                _watchRenewal.Filter = "seamless_state.json";
                _watchRenewal.NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.Size | NotifyFilters.FileName;
                _watchRenewal.Changed += bump;
                _watchRenewal.Created += bump;
                _watchRenewal.Renamed += (s, e) => bump(s, e);
                _watchRenewal.EnableRaisingEvents = true;
            }
        }
        catch { }
    }

    void Drag(object sender, MouseEventArgs e)
    {
        if (e.Button != MouseButtons.Left) return;
        Native.ReleaseCapture();
        Native.SendMessage(Handle, 0xA1, (IntPtr)0x2, IntPtr.Zero);
    }

    void ManualRefresh()
    {
        _timer.Stop();
        RefreshNow(true);
        _timer.Start();
    }

    void RefreshNow(bool manual)
    {
        if (_busy) return;
        _busy = true;
        _refresh.Enabled = false;
        try
        {
            var session = CursorAuth.Load();
            var jwt = session.Jwt;
            var membership = session.Membership;
            var sub = JwtClaim(jwt, "sub");

            // Email: seamless email (renewal) or cachedEmail (ide) already loaded;
            // then GetEmail → JWT email → sub.
            string email = session.Email;
            if (string.IsNullOrEmpty(email))
            {
                try { email = ExtractString(PostJson(jwt, "https://api2.cursor.sh/aiserver.v1.AuthService/GetEmail"), "email"); }
                catch { }
            }
            if (string.IsNullOrEmpty(email)) email = JwtClaim(jwt, "email");
            if (string.IsNullOrEmpty(email)) email = ShortSub(sub);

            var switched = !string.IsNullOrEmpty(sub) && _lastSub != "" && sub != _lastSub;
            _lastSub = sub ?? "";

            // Server GetPlanInfo.planName is authoritative; local stripeMembershipType is often stale.
            try
            {
                var planName = ExtractString(PostJson(jwt, "https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo"), "planName");
                if (!string.IsNullOrEmpty(planName)) membership = planName.ToLowerInvariant();
            }
            catch { }

            var json = PostJson(jwt, "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage");
            var used = ParseDouble(json, "totalPercentUsed");
            var rem = Math.Max(0, Math.Min(100, 100.0 - used));
            var display = ExtractString(json, "displayMessage");
            if (string.IsNullOrEmpty(display))
                display = string.Format("Used {0:0.#}% · Remaining {1:0.#}%", used, rem);

            _user.Text = Truncate(email, 26);
            _plan.Text = string.IsNullOrEmpty(membership) ? "" : membership;
            _bar.Value = (int)Math.Round(rem * 10);
            _pct.Text = string.Format("{0:0.#}%", rem);
            _pct.ForeColor = rem <= 10 ? Color.Salmon : rem <= 30 ? Color.Gold : Color.FromArgb(120, 220, 140);
            _msg.Text = Truncate(display, 42);
            string prefix;
            if (manual) prefix = "refreshed · ";
            else if (switched) prefix = "switched · ";
            else if (session.Source == CursorAuth.SourceRenewal) prefix = "renewal · ";
            else prefix = "left=remaining · ";
            _status.Text = prefix + "next @" + DateTime.Now.AddMinutes(1).ToString("HH:mm:ss");
        }
        catch (Exception ex)
        {
            Fail(ex.Message);
        }
        finally
        {
            _busy = false;
            _refresh.Enabled = true;
        }
    }

    void Fail(string msg)
    {
        _user.Text = "Cursor Usage";
        _plan.Text = "";
        _bar.Value = 0;
        _pct.Text = "-";
        _pct.ForeColor = Color.Salmon;
        _msg.Text = Truncate(msg, 42);
        _status.Text = DateTime.Now.ToString("HH:mm:ss");
    }

    internal static string PostUsage(string jwt)
    {
        return PostJson(jwt, "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage");
    }

    internal static string PostGetEmail(string jwt)
    {
        return PostJson(jwt, "https://api2.cursor.sh/aiserver.v1.AuthService/GetEmail");
    }

    internal static string PostJson(string jwt, string url)
    {
        var req = (HttpWebRequest)WebRequest.Create(url);
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

        try
        {
            var session = CursorAuth.Load();
            var jwt = session.Jwt;
            var email = session.Email;
            if (string.IsNullOrEmpty(email))
            {
                try
                {
                    var m = Regex.Match(HudForm.PostGetEmail(jwt), "\"email\"\\s*:\\s*\"([^\"]+)\"");
                    if (m.Success) email = m.Groups[1].Value;
                }
                catch { }
            }
            var cachedMembership = session.Membership;
            var membership = cachedMembership;
            var planJson = "";
            try
            {
                planJson = HudForm.PostJson(jwt, "https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo");
                var planName = Regex.Match(planJson, "\"planName\"\\s*:\\s*\"([^\"]+)\"");
                if (planName.Success) membership = planName.Groups[1].Value.ToLowerInvariant();
            }
            catch { }
            var json = HudForm.PostUsage(jwt);
            var used = HudForm.ParseDouble(json, "totalPercentUsed");
            Console.WriteLine("source=" + session.Source);
            Console.WriteLine("email=" + email);
            Console.WriteLine("plan=" + membership);
            Console.WriteLine("db_stripeMembershipType=" + cachedMembership);
            Console.WriteLine("used=" + used.ToString(System.Globalization.CultureInfo.InvariantCulture) + "%");
            Console.WriteLine("remaining=" + (100.0 - used).ToString(System.Globalization.CultureInfo.InvariantCulture) + "%");
            Console.WriteLine("--- GetPlanInfo ---");
            Console.WriteLine(string.IsNullOrEmpty(planJson) ? "(empty)" : planJson);
            Console.WriteLine("--- GetCurrentPeriodUsage ---");
            Console.WriteLine(json);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("ERROR: " + ex.Message);
            Environment.ExitCode = 1;
        }
    }
}
