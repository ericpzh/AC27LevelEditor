"""
AC25 Level Editor - GUI for editing .acl flight schedules.
Built with tkinter (zero dependencies beyond Python stdlib).
"""

import tkinter as tk
from tkinter import ttk, filedialog, messagebox, simpledialog
import os
import sys

from acl_parser import (
    load_flights, save_flights, export_csv, import_csv,
    count_stats, FIELDS, FIELD_LABELS
)

# Add current dir to path for PyInstaller
if getattr(sys, 'frozen', False):
    sys.path.insert(0, os.path.dirname(sys.executable))


class LevelEditor:
    def __init__(self, root):
        self.root = root
        self.root.title("AC25 Level Editor")
        self.root.geometry("1400x800")
        self.root.minsize(1000, 600)

        self.acl_path = None
        self.flights = []
        self.before_text = ""
        self.after_text = ""
        self.array_content = ""
        self.original_blocks = []
        self.modified = False

        self._build_menu()
        self._build_toolbar()
        self._build_table()
        self._build_statusbar()

        # Bind keyboard shortcuts
        self.root.bind('<Control-s>', lambda e: self.save())
        self.root.bind('<Control-o>', lambda e: self.open_file())
        self.root.bind('<Control-n>', lambda e: self.add_flight())
        self.root.bind('<Delete>', lambda e: self.delete_flight())

        self._update_title()

    # ─── Menu ───────────────────────────────────────────────

    def _build_menu(self):
        menubar = tk.Menu(self.root)
        self.root.config(menu=menubar)

        file_menu = tk.Menu(menubar, tearoff=0)
        file_menu.add_command(label="打开 .acl", command=self.open_file, accelerator="Ctrl+O")
        file_menu.add_command(label="保存", command=self.save, accelerator="Ctrl+S")
        file_menu.add_command(label="另存为...", command=self.save_as)
        file_menu.add_separator()
        file_menu.add_command(label="导入 CSV (追加)", command=self.import_csv_append)
        file_menu.add_command(label="导入 CSV (替换)", command=self.import_csv_replace)
        file_menu.add_command(label="导出 CSV", command=self.export_to_csv)
        file_menu.add_separator()
        file_menu.add_command(label="退出", command=self.root.quit)
        menubar.add_cascade(label="文件", menu=file_menu)

        edit_menu = tk.Menu(menubar, tearoff=0)
        edit_menu.add_command(label="添加航班", command=self.add_flight, accelerator="Ctrl+N")
        edit_menu.add_command(label="删除航班", command=self.delete_flight, accelerator="Del")
        edit_menu.add_command(label="复制航班", command=self.duplicate_flight)
        edit_menu.add_separator()
        edit_menu.add_command(label="批量生成呼号", command=self.batch_callsign)
        edit_menu.add_command(label="批量设置语音", command=self.batch_voice)
        edit_menu.add_command(label="批量设置语言", command=self.batch_language)
        menubar.add_cascade(label="编辑", menu=edit_menu)

    # ─── Toolbar ────────────────────────────────────────────

    def _build_toolbar(self):
        toolbar = ttk.Frame(self.root, padding=(5, 5))
        toolbar.pack(fill=tk.X)

        ttk.Button(toolbar, text="打开 .acl", command=self.open_file).pack(side=tk.LEFT, padx=2)
        ttk.Button(toolbar, text="保存", command=self.save).pack(side=tk.LEFT, padx=2)
        ttk.Separator(toolbar, orient=tk.VERTICAL).pack(side=tk.LEFT, fill=tk.Y, padx=8)
        ttk.Button(toolbar, text="导入 CSV", command=self.import_csv_append).pack(side=tk.LEFT, padx=2)
        ttk.Button(toolbar, text="导出 CSV", command=self.export_to_csv).pack(side=tk.LEFT, padx=2)
        ttk.Separator(toolbar, orient=tk.VERTICAL).pack(side=tk.LEFT, fill=tk.Y, padx=8)
        ttk.Button(toolbar, text="➕ 添加", command=self.add_flight).pack(side=tk.LEFT, padx=2)
        ttk.Button(toolbar, text="✖ 删除", command=self.delete_flight).pack(side=tk.LEFT, padx=2)
        ttk.Button(toolbar, text="📋 复制", command=self.duplicate_flight).pack(side=tk.LEFT, padx=2)

        # Search
        ttk.Separator(toolbar, orient=tk.VERTICAL).pack(side=tk.LEFT, fill=tk.Y, padx=8)
        ttk.Label(toolbar, text="搜索:").pack(side=tk.LEFT, padx=(0, 2))
        self.search_var = tk.StringVar()
        self.search_var.trace('w', lambda *a: self._apply_filter())
        ttk.Entry(toolbar, textvariable=self.search_var, width=15).pack(side=tk.LEFT, padx=2)

        # Filter by type
        ttk.Label(toolbar, text="类型:").pack(side=tk.LEFT, padx=(10, 2))
        self.filter_var = tk.StringVar(value="全部")
        filter_combo = ttk.Combobox(toolbar, textvariable=self.filter_var,
                                     values=["全部", "进港", "离港"],
                                     state="readonly", width=6)
        filter_combo.pack(side=tk.LEFT, padx=2)
        filter_combo.bind('<<ComboboxSelected>>', lambda e: self._apply_filter())

    # ─── Table ──────────────────────────────────────────────

    def _build_table(self):
        table_frame = ttk.Frame(self.root)
        table_frame.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)

        # Columns: #, then all fields
        columns = ["#"] + [f[0] for f in FIELDS]
        display_cols = ["#"] + [FIELD_LABELS.get(f[0], f[0]) for f in FIELDS]

        self.tree = ttk.Treeview(table_frame, columns=columns, show="headings",
                                  selectmode="extended")

        # Column widths
        col_widths = {
            "#": 40, "CallSign": 90, "DepartureAirport": 55, "ArrivalAirport": 55,
            "Stand": 70, "Runway": 55, "OffBlockTime": 70, "TakeoffTime": 70,
            "LandingTime": 70, "InBlockTime": 70, "AirlineName": 55,
            "AircraftType": 130, "Voice": 130, "Language": 55,
        }

        for i, (col, disp) in enumerate(zip(columns, display_cols)):
            width = col_widths.get(col, 80)
            self.tree.heading(col, text=disp, command=lambda c=col: self._sort_by(c))
            self.tree.column(col, width=width, minwidth=40)

        # Scrollbars
        vsb = ttk.Scrollbar(table_frame, orient=tk.VERTICAL, command=self.tree.yview)
        hsb = ttk.Scrollbar(table_frame, orient=tk.HORIZONTAL, command=self.tree.xview)
        self.tree.configure(yscrollcommand=vsb.set, xscrollcommand=hsb.set)
        self.tree.grid(row=0, column=0, sticky="nsew")
        vsb.grid(row=0, column=1, sticky="ns")
        hsb.grid(row=1, column=0, sticky="ew")
        table_frame.grid_rowconfigure(0, weight=1)
        table_frame.grid_columnconfigure(0, weight=1)

        # Double-click to edit
        self.tree.bind("<Double-1>", self._edit_cell)
        # Right-click context menu
        self.tree.bind("<Button-3>", self._context_menu)

        # Tag colors
        self.tree.tag_configure("arrival", background="#e8f5e9")   # greenish
        self.tree.tag_configure("departure", background="#e3f2fd")  # blueish

    # ─── Status Bar ─────────────────────────────────────────

    def _build_statusbar(self):
        status = ttk.Frame(self.root, padding=(5, 3))
        status.pack(fill=tk.X, side=tk.BOTTOM)

        self.file_label = ttk.Label(status, text="未打开文件")
        self.file_label.pack(side=tk.LEFT)

        self.stats_label = ttk.Label(status, text="")
        self.stats_label.pack(side=tk.RIGHT)

    # ─── File Operations ────────────────────────────────────

    def open_file(self):
        if self.modified and not self._confirm_discard():
            return

        path = filedialog.askopenfilename(
            title="打开 .acl 文件",
            filetypes=[("ACL 关卡文件", "*.acl"), ("所有文件", "*.*")]
        )
        if not path:
            return
        self._load_acl(path)

    def _load_acl(self, path):
        try:
            result = load_flights(path)
            self.flights, self.before_text, self.after_text, self.array_content, self.original_blocks = result
            self.acl_path = path
            self.modified = False
            self._refresh_table()
            self._update_title()
            self._update_status()
        except Exception as e:
            messagebox.showerror("加载失败", f"无法解析文件:\n{e}")

    def save(self):
        if not self.acl_path:
            return self.save_as()
        try:
            save_flights(self.acl_path, self.flights, self.before_text,
                        self.after_text, self.array_content, self.original_blocks)
            self.modified = False
            self._update_title()
            self._update_status()
            # Reload to refresh original_blocks
            result = load_flights(self.acl_path)
            self.flights, self.before_text, self.after_text, self.array_content, self.original_blocks = result
            messagebox.showinfo("保存成功", f"已保存到:\n{self.acl_path}")
        except Exception as e:
            messagebox.showerror("保存失败", str(e))

    def save_as(self):
        path = filedialog.asksaveasfilename(
            title="另存为",
            defaultextension=".acl",
            filetypes=[("ACL 关卡文件", "*.acl"), ("所有文件", "*.*")]
        )
        if not path:
            return
        self.acl_path = path
        self.save()

    def _confirm_discard(self):
        return messagebox.askyesno("未保存修改", "有未保存的修改，确定丢弃？")

    # ─── CSV Import/Export ──────────────────────────────────

    def import_csv_append(self):
        path = filedialog.askopenfilename(
            title="导入 CSV (追加)",
            filetypes=[("CSV 文件", "*.csv"), ("所有文件", "*.*")]
        )
        if not path:
            return
        try:
            new_flights = import_csv(path)
            if new_flights:
                self.flights.extend(new_flights)
                self.modified = True
                self._refresh_table()
                self._update_status()
                messagebox.showinfo("导入完成", f"追加了 {len(new_flights)} 个航班")
            else:
                messagebox.showwarning("无数据", "CSV 文件中没有有效的航班数据")
        except Exception as e:
            messagebox.showerror("导入失败", str(e))

    def import_csv_replace(self):
        path = filedialog.askopenfilename(
            title="导入 CSV (替换)",
            filetypes=[("CSV 文件", "*.csv"), ("所有文件", "*.*")]
        )
        if not path:
            return
        try:
            new_flights = import_csv(path)
            if new_flights:
                self.flights = new_flights
                self.modified = True
                self._refresh_table()
                self._update_status()
                messagebox.showinfo("导入完成", f"替换为 {len(new_flights)} 个航班")
            else:
                messagebox.showwarning("无数据", "CSV 文件中没有有效的航班数据")
        except Exception as e:
            messagebox.showerror("导入失败", str(e))

    def export_to_csv(self):
        if not self.flights:
            messagebox.showwarning("无数据", "没有航班数据可导出")
            return
        path = filedialog.asksaveasfilename(
            title="导出 CSV",
            defaultextension=".csv",
            filetypes=[("CSV 文件", "*.csv"), ("所有文件", "*.*")]
        )
        if not path:
            return
        try:
            export_csv(self.flights, path)
            messagebox.showinfo("导出完成", f"导出了 {len(self.flights)} 个航班")
        except Exception as e:
            messagebox.showerror("导出失败", str(e))

    # ─── Flight Editing ─────────────────────────────────────

    def add_flight(self):
        new_flight = {f[0]: "" for f in FIELDS}
        new_flight["CallSign"] = "NEW0001"
        new_flight["AircraftType"] = "AIRBUS A-320neo"
        new_flight["Voice"] = "Yeager"
        new_flight["Language"] = "en"
        self.flights.append(new_flight)
        self.modified = True
        self._refresh_table()
        # Scroll to bottom and select new row
        children = self.tree.get_children()
        if children:
            self.tree.see(children[-1])
            self.tree.selection_set(children[-1])
        self._update_status()

    def delete_flight(self):
        selected = self.tree.selection()
        if not selected:
            messagebox.showinfo("提示", "请先选择要删除的航班")
            return
        count = len(selected)
        if messagebox.askyesno("确认删除", f"确定要删除 {count} 个航班？"):
            # Get indices from tree item tags
            indices = []
            for item in selected:
                idx = int(self.tree.item(item, "tags")[0])
                indices.append(idx)
            # Delete in reverse order
            for idx in sorted(indices, reverse=True):
                del self.flights[idx]
            self.modified = True
            self._refresh_table()
            self._update_status()

    def duplicate_flight(self):
        selected = self.tree.selection()
        if not selected:
            messagebox.showinfo("提示", "请先选择要复制的航班")
            return
        for item in selected:
            idx = int(self.tree.item(item, "tags")[0])
            new_flight = dict(self.flights[idx])
            new_flight["CallSign"] = new_flight.get("CallSign", "") + "_COPY"
            self.flights.append(new_flight)
        self.modified = True
        self._refresh_table()
        self._update_status()

    def batch_callsign(self):
        prefix = simpledialog.askstring("批量呼号", "输入前缀 (如 CCA):", initialvalue="CCA")
        if not prefix:
            return
        start = simpledialog.askinteger("编号起点", "起始编号:", initialvalue=1, minvalue=1)
        if start is None:
            return
        for i, fl in enumerate(self.flights):
            fl["CallSign"] = f"{prefix}{start + i:04d}"
        self.modified = True
        self._refresh_table()
        self._update_status()
        messagebox.showinfo("完成", f"已设置 {len(self.flights)} 个呼号: {prefix}{start:04d}~{prefix}{start+len(self.flights)-1:04d}")

    def batch_voice(self):
        voice = simpledialog.askstring("批量语音", "语音包名称:", initialvalue="Yeager")
        if not voice:
            return
        for fl in self.flights:
            fl["Voice"] = voice
        self.modified = True
        self._refresh_table()
        messagebox.showinfo("完成", f"已设置 {len(self.flights)} 个航班语音为: {voice}")

    def batch_language(self):
        lang = simpledialog.askstring("批量语言", "语言代码 (en/zh):", initialvalue="en")
        if not lang:
            return
        for fl in self.flights:
            fl["Language"] = lang
        self.modified = True
        self._refresh_table()
        messagebox.showinfo("完成", f"已设置 {len(self.flights)} 个航班语言为: {lang}")

    # ─── Cell Editing ───────────────────────────────────────

    def _edit_cell(self, event):
        region = self.tree.identify_region(event.x, event.y)
        if region != "cell":
            return

        column = self.tree.identify_column(event.x)
        item = self.tree.identify_row(event.y)
        if not item or not column:
            return

        col_idx = int(column.replace("#", "")) - 1  # 0-based
        if col_idx < 0:  # row number column
            return

        flight_idx = int(self.tree.item(item, "tags")[0])
        field_name = FIELDS[col_idx][0]

        # Get current value
        bbox = self.tree.bbox(item, column)
        if not bbox:
            return

        current_val = self.flights[flight_idx].get(field_name, "")

        # Create dropdown for some fields
        if field_name == "Language":
            self._show_dropdown(bbox, item, col_idx, flight_idx, field_name,
                               ["en", "zh"], current_val)
        else:
            self._show_entry(bbox, item, col_idx, flight_idx, field_name, current_val)

    def _show_entry(self, bbox, item, col_idx, flight_idx, field_name, current_val):
        entry = tk.Entry(self.tree)
        entry.place(x=bbox[0], y=bbox[1], width=bbox[2], height=bbox[3])
        entry.insert(0, current_val)
        entry.select_range(0, tk.END)
        entry.focus_set()

        def save_edit(event=None):
            new_val = entry.get().strip()
            if new_val != current_val:
                self.flights[flight_idx][field_name] = new_val
                self.modified = True
                self._update_row(item, flight_idx)
                self._update_status()
            entry.destroy()

        def cancel_edit(event=None):
            entry.destroy()

        entry.bind("<Return>", save_edit)
        entry.bind("<Escape>", cancel_edit)
        entry.bind("<FocusOut>", save_edit)

    def _show_dropdown(self, bbox, item, col_idx, flight_idx, field_name, values, current_val):
        combo = ttk.Combobox(self.tree, values=values, state="readonly")
        combo.place(x=bbox[0], y=bbox[1], width=bbox[2], height=bbox[3])
        combo.set(current_val if current_val in values else values[0])
        combo.focus_set()

        def save_combo(event=None):
            new_val = combo.get()
            if new_val != current_val:
                self.flights[flight_idx][field_name] = new_val
                self.modified = True
                self._update_row(item, flight_idx)
                self._update_status()
            combo.destroy()

        combo.bind("<<ComboboxSelected>>", save_combo)
        combo.bind("<Escape>", lambda e: combo.destroy())
        combo.bind("<FocusOut>", save_combo)

    # ─── Context Menu ───────────────────────────────────────

    def _context_menu(self, event):
        menu = tk.Menu(self.root, tearoff=0)
        menu.add_command(label="添加航班", command=self.add_flight)

        selected = self.tree.selection()
        if selected:
            menu.add_command(label="删除选中", command=self.delete_flight)
            menu.add_command(label="复制选中", command=self.duplicate_flight)
            menu.add_separator()
            menu.add_command(label="向上移动", command=self._move_up)
            menu.add_command(label="向下移动", command=self._move_down)

        try:
            menu.tk_popup(event.x_root, event.y_root)
        finally:
            menu.grab_release()

    def _move_up(self):
        selected = self.tree.selection()
        if not selected:
            return
        idx = int(self.tree.item(selected[0], "tags")[0])
        if idx > 0:
            self.flights[idx], self.flights[idx-1] = self.flights[idx-1], self.flights[idx]
            self.modified = True
            self._refresh_table()
            # Re-select
            children = self.tree.get_children()
            self.tree.selection_set(children[idx-1])

    def _move_down(self):
        selected = self.tree.selection()
        if not selected:
            return
        idx = int(self.tree.item(selected[0], "tags")[0])
        if idx < len(self.flights) - 1:
            self.flights[idx], self.flights[idx+1] = self.flights[idx+1], self.flights[idx]
            self.modified = True
            self._refresh_table()
            children = self.tree.get_children()
            self.tree.selection_set(children[idx+1])

    # ─── Table Refresh ──────────────────────────────────────

    def _refresh_table(self):
        # Clear
        for item in self.tree.get_children():
            self.tree.delete(item)

        search = self.search_var.get().strip().lower()
        filter_type = self.filter_var.get()

        for i, fl in enumerate(self.flights):
            # Apply filter
            if filter_type == "进港":
                if not fl.get("LandingTime", "").strip():
                    continue
            elif filter_type == "离港":
                if not fl.get("OffBlockTime", "").strip():
                    continue

            # Apply search
            if search:
                match = False
                for field_name, _ in FIELDS:
                    if search in str(fl.get(field_name, "")).lower():
                        match = True
                        break
                if not match:
                    continue

            values = [i + 1]
            for field_name, _ in FIELDS:
                values.append(fl.get(field_name, ""))

            # Determine tag
            is_arrival = bool(fl.get("LandingTime", "").strip())
            is_departure = bool(fl.get("OffBlockTime", "").strip())
            tag = "arrival" if is_arrival else ("departure" if is_departure else "")

            self.tree.insert("", tk.END, values=values, tags=(str(i), tag))

    def _update_row(self, item, flight_idx):
        values = [flight_idx + 1]
        fl = self.flights[flight_idx]
        for field_name, _ in FIELDS:
            values.append(fl.get(field_name, ""))
        is_arrival = bool(fl.get("LandingTime", "").strip())
        is_departure = bool(fl.get("OffBlockTime", "").strip())
        tag = "arrival" if is_arrival else ("departure" if is_departure else "")
        self.tree.item(item, values=values, tags=(str(flight_idx), tag))

    def _apply_filter(self):
        self._refresh_table()
        self._update_status()

    # ─── Sorting ────────────────────────────────────────────

    def _sort_by(self, col):
        if col == "#":
            self.flights.sort(key=lambda f: f.get("CallSign", ""))
        else:
            self.flights.sort(key=lambda f: f.get(col, ""))
        self.modified = True
        self._refresh_table()

    # ─── UI Updates ─────────────────────────────────────────

    def _update_title(self):
        fname = os.path.basename(self.acl_path) if self.acl_path else "未保存"
        mod = " *" if self.modified else ""
        self.root.title(f"AC25 Level Editor - {fname}{mod}")

    def _update_status(self):
        if self.acl_path:
            self.file_label.config(text=os.path.basename(self.acl_path))
        else:
            self.file_label.config(text="未打开文件")

        arrivals, departures = count_stats(self.flights)
        self.stats_label.config(
            text=f"总计: {len(self.flights)} | 进港: {arrivals} | 离港: {departures}"
        )

    def on_close(self):
        if self.modified:
            if not self._confirm_discard():
                return
        self.root.destroy()


def main():
    root = tk.Tk()
    app = LevelEditor(root)
    root.protocol("WM_DELETE_WINDOW", app.on_close)

    # Try to set icon if available
    try:
        root.iconbitmap(default="")
    except Exception:
        pass

    root.mainloop()


if __name__ == "__main__":
    main()
