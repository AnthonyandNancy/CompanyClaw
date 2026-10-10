// CompanyClaw generic desktop test fixture — compiled form.
//
// The scripted version of this fixture exposes its controls through the legacy
// MSAA bridge, so UI Automation sees anonymous `Pane` nodes instead of the named
// buttons, edits and lists a real application provides. A fixture that cannot
// show a semantic control tree cannot test semantic location, so this compiled
// build exists to give the automation path something faithful to work on.
//
// It needs no SDK: `csc.exe` ships with the .NET Framework that is part of
// Windows, and `tools/testapp/build-fixture.ps1` invokes it.
//
// Every control has a stable Name (= AutomationId) so tests address controls by
// identity rather than by screen coordinates:
//
//   FIXTURE_WINDOW          main window
//   FIXTURE_APP_NAME        read-only identity label
//   FIXTURE_NAME_INPUT      text field (accepts Chinese input)
//   FIXTURE_FIND_BUTTON     semantic button
//   FIXTURE_RESULT_LIST     list of simulated contacts
//   FIXTURE_MESSAGE_INPUT   multi-line draft field (no side effect)
//   FIXTURE_SEND_BUTTON     the final commit point
//   FIXTURE_SEND_LOG        read-only proof of whether a send happened
//   FIXTURE_SENT_RECIPIENT  last recipient
//   FIXTURE_SENT_BODY       last body
//   FIXTURE_SCROLL_AREA     scrollable region with 200 rows
//   FIXTURE_CUSTOM_BUTTON   owner-drawn button (no native Invoke pattern)
//   FIXTURE_DELAYED_DIALOG  opens a window after 3 seconds
//   FIXTURE_ERROR_DIALOG    raises a modal error
//   FIXTURE_DROP_TARGET     accepts dropped files
//   FIXTURE_DROPPED_FILES   names of received files
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

namespace CompanyClaw
{
    public class TestApp : Form
    {
        private int sendCount;
        private Label sendLog;
        private Label sentRecipient;
        private Label sentBody;
        private Label droppedFiles;
        private TextBox nameInput;
        private TextBox messageInput;
        private ListBox resultList;

        private static readonly string[] Contacts = { "测试联系人 甲", "测试联系人 乙", "测试联系人 丙" };

        public TestApp(string scenario)
        {
            Text = "CompanyClaw Test App";
            Name = "FIXTURE_WINDOW";
            Size = new Size(780, 680);
            StartPosition = FormStartPosition.CenterScreen;
            AllowDrop = true;

            Label identity = MakeLabel("应用名称：CompanyClaw 通用测试程序", 12, 16, 420);
            identity.Name = "FIXTURE_APP_NAME";
            Controls.Add(identity);

            Controls.Add(MakeLabel("查找联系人", 44, 16, 120));

            nameInput = new TextBox();
            nameInput.Top = 66;
            nameInput.Left = 16;
            nameInput.Width = 260;
            nameInput.Name = "FIXTURE_NAME_INPUT";
            Controls.Add(nameInput);

            Button find = new Button();
            find.Text = "查找";
            find.Top = 64;
            find.Left = 288;
            find.Width = 90;
            find.Name = "FIXTURE_FIND_BUTTON";
            find.Click += OnFind;
            Controls.Add(find);

            resultList = new ListBox();
            resultList.Top = 96;
            resultList.Left = 16;
            resultList.Width = 380;
            resultList.Height = 120;
            resultList.Name = "FIXTURE_RESULT_LIST";
            resultList.Items.AddRange(Contacts);
            Controls.Add(resultList);

            Controls.Add(MakeLabel("消息草稿（输入不会产生副作用）", 228, 16, 320));

            messageInput = new TextBox();
            messageInput.Top = 250;
            messageInput.Left = 16;
            messageInput.Width = 380;
            messageInput.Height = 90;
            messageInput.Multiline = true;
            messageInput.ScrollBars = ScrollBars.Vertical;
            messageInput.Name = "FIXTURE_MESSAGE_INPUT";
            Controls.Add(messageInput);

            Button send = new Button();
            send.Text = "发送";
            send.Top = 348;
            send.Left = 16;
            send.Width = 110;
            send.Name = "FIXTURE_SEND_BUTTON";
            send.Click += OnSend;
            if (scenario == "restricted")
            {
                send.Enabled = false;
            }
            Controls.Add(send);

            sendLog = MakeLabel("尚未发送", 380, 16, 380);
            sendLog.Name = "FIXTURE_SEND_LOG";
            Controls.Add(sendLog);

            sentRecipient = MakeLabel("", 402, 16, 380);
            sentRecipient.Name = "FIXTURE_SENT_RECIPIENT";
            Controls.Add(sentRecipient);

            sentBody = MakeLabel("", 424, 16, 380);
            sentBody.Name = "FIXTURE_SENT_BODY";
            Controls.Add(sentBody);

            Controls.Add(MakeLabel("长列表（滚动测试）", 452, 430, 200));
            Panel scrollArea = new Panel();
            scrollArea.Top = 474;
            scrollArea.Left = 430;
            scrollArea.Width = 300;
            scrollArea.Height = 110;
            scrollArea.AutoScroll = true;
            scrollArea.Name = "FIXTURE_SCROLL_AREA";
            Panel inner = new Panel();
            inner.Width = 270;
            inner.Height = 200 * 18;
            for (int row = 1; row <= 200; row++)
            {
                Label line = new Label();
                line.Text = "第 " + row + " 行";
                line.Top = (row - 1) * 18;
                line.Left = 4;
                line.Width = 260;
                inner.Controls.Add(line);
            }
            scrollArea.Controls.Add(inner);
            Controls.Add(scrollArea);

            Button custom = new Button();
            custom.Text = "自绘按钮";
            custom.Top = 12;
            custom.Left = 430;
            custom.Width = 130;
            custom.FlatStyle = FlatStyle.Flat;
            custom.FlatAppearance.BorderSize = 0;
            custom.Name = "FIXTURE_CUSTOM_BUTTON";
            custom.Paint += OnCustomPaint;
            Controls.Add(custom);

            Button delayed = new Button();
            delayed.Text = "打开延迟窗口";
            delayed.Top = 48;
            delayed.Left = 430;
            delayed.Width = 160;
            delayed.Name = "FIXTURE_DELAYED_DIALOG";
            delayed.Click += OnDelayed;
            Controls.Add(delayed);

            Button error = new Button();
            error.Text = "触发错误提示";
            error.Top = 84;
            error.Left = 430;
            error.Width = 160;
            error.Name = "FIXTURE_ERROR_DIALOG";
            error.Click += OnError;
            Controls.Add(error);

            Controls.Add(MakeLabel("拖拽区（接收文件）", 468, 16, 220));
            Panel dropTarget = new Panel();
            dropTarget.Top = 490;
            dropTarget.Left = 16;
            dropTarget.Width = 380;
            dropTarget.Height = 84;
            dropTarget.BackColor = Color.Gainsboro;
            dropTarget.AllowDrop = true;
            dropTarget.Name = "FIXTURE_DROP_TARGET";
            dropTarget.DragEnter += OnDragEnter;
            dropTarget.DragDrop += OnDragDrop;
            droppedFiles = MakeLabel("（未收到文件）", 12, 8, 360);
            droppedFiles.Name = "FIXTURE_DROPPED_FILES";
            dropTarget.Controls.Add(droppedFiles);
            Controls.Add(dropTarget);
        }

        private static Label MakeLabel(string text, int top, int left, int width)
        {
            Label label = new Label();
            label.Text = text;
            label.Top = top;
            label.Left = left;
            label.Width = width;
            label.Height = 20;
            return label;
        }

        private void OnFind(object sender, EventArgs e)
        {
            resultList.Items.Clear();
            string needle = nameInput.Text.Trim();
            if (needle.Length == 0)
            {
                resultList.Items.AddRange(Contacts);
                return;
            }
            foreach (string candidate in Contacts)
            {
                if (candidate.IndexOf(needle, StringComparison.Ordinal) >= 0)
                {
                    resultList.Items.Add(candidate);
                }
            }
            if (resultList.Items.Count == 0)
            {
                resultList.Items.Add("（无匹配）");
            }
        }

        // The only place a side effect happens. A test can therefore observe
        // precisely whether an unapproved "send" reached the application.
        private void OnSend(object sender, EventArgs e)
        {
            string recipient = resultList.SelectedItem != null
                ? resultList.SelectedItem.ToString()
                : "（未选择联系人）";
            sendCount++;
            sendLog.Text = "已发送 " + sendCount + " 次";
            sentRecipient.Text = "收件人：" + recipient;
            sentBody.Text = "内容：" + messageInput.Text;
        }

        private void OnCustomPaint(object sender, PaintEventArgs e)
        {
            Button button = (Button)sender;
            e.Graphics.FillRectangle(Brushes.LightSteelBlue, 0, 0, button.Width, button.Height);
            e.Graphics.DrawString(button.Text, button.Font, Brushes.Black, 10, 8);
        }

        private void OnDelayed(object sender, EventArgs e)
        {
            Timer timer = new Timer();
            timer.Interval = 3000;
            timer.Tick += delegate(object s, EventArgs args)
            {
                timer.Stop();
                Form delayed = new Form();
                delayed.Text = "延迟窗口";
                delayed.Name = "FIXTURE_DELAYED_WINDOW";
                delayed.Size = new Size(360, 180);
                delayed.Controls.Add(MakeLabel("延迟出现的窗口，用于验证等待逻辑。", 24, 16, 300));
                delayed.ShowDialog(this);
            };
            timer.Start();
        }

        private void OnError(object sender, EventArgs e)
        {
            MessageBox.Show(
                this,
                "这是一个测试用错误提示（TEST_FIXTURE_ERROR）。",
                "错误",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }

        private void OnDragEnter(object sender, DragEventArgs e)
        {
            if (e.Data.GetDataPresent(DataFormats.FileDrop))
            {
                e.Effect = DragDropEffects.Copy;
            }
        }

        private void OnDragDrop(object sender, DragEventArgs e)
        {
            string[] paths = (string[])e.Data.GetData(DataFormats.FileDrop);
            List<string> names = new List<string>();
            foreach (string path in paths)
            {
                names.Add(Path.GetFileName(path));
            }
            droppedFiles.Text = "收到：" + string.Join("、", names.ToArray());
        }

        [STAThread]
        public static void Main(string[] args)
        {
            string scenario = args.Length > 0 ? args[0] : "default";
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new TestApp(scenario));
        }
    }
}
