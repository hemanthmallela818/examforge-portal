from pathlib import Path

from docx import Document
from docx.enum.section import WD_SECTION_START
from docx.enum.style import WD_STYLE_TYPE
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor


OUTPUT = Path(r"C:\Users\heman\Downloads\CBT\MockTest-main\docs\JEE_Examination_Portal_Client_Operations_Guide.docx")
NAVY = "1E3A5F"
LIGHT_BLUE = "EAF2F8"
PALE_GRAY = "F5F7FA"
BORDER = "D9D9D9"
BLACK = RGBColor(0, 0, 0)
MUTED = RGBColor(75, 85, 99)


def set_cell_shading(cell, fill):
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = tc_pr.find(qn("w:shd"))
    if shd is None:
        shd = OxmlElement("w:shd")
        tc_pr.append(shd)
    shd.set(qn("w:fill"), fill)


def set_cell_margins(cell, top=110, start=120, bottom=110, end=120):
    tc = cell._tc
    tc_pr = tc.get_or_add_tcPr()
    tc_mar = tc_pr.first_child_found_in("w:tcMar")
    if tc_mar is None:
        tc_mar = OxmlElement("w:tcMar")
        tc_pr.append(tc_mar)
    for margin, value in (("top", top), ("start", start), ("bottom", bottom), ("end", end)):
        node = tc_mar.find(qn(f"w:{margin}"))
        if node is None:
            node = OxmlElement(f"w:{margin}")
            tc_mar.append(node)
        node.set(qn("w:w"), str(value))
        node.set(qn("w:type"), "dxa")


def set_table_borders(table):
    tbl_pr = table._tbl.tblPr
    borders = tbl_pr.first_child_found_in("w:tblBorders")
    if borders is None:
        borders = OxmlElement("w:tblBorders")
        tbl_pr.append(borders)
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        tag = qn(f"w:{edge}")
        node = borders.find(tag)
        if node is None:
            node = OxmlElement(f"w:{edge}")
            borders.append(node)
        node.set(qn("w:val"), "single")
        node.set(qn("w:sz"), "6")
        node.set(qn("w:space"), "0")
        node.set(qn("w:color"), BORDER)


def set_repeat_table_header(row):
    tr_pr = row._tr.get_or_add_trPr()
    tbl_header = OxmlElement("w:tblHeader")
    tbl_header.set(qn("w:val"), "true")
    tr_pr.append(tbl_header)


def set_run_font(run, name="Aptos", size=None, bold=None, color=None):
    run.font.name = name
    run._element.get_or_add_rPr().get_or_add_rFonts().set(qn("w:ascii"), name)
    run._element.get_or_add_rPr().get_or_add_rFonts().set(qn("w:hAnsi"), name)
    if size is not None:
        run.font.size = Pt(size)
    if bold is not None:
        run.bold = bold
    if color is not None:
        run.font.color.rgb = color


def add_page_number(paragraph):
    run = paragraph.add_run()
    fld_char_1 = OxmlElement("w:fldChar")
    fld_char_1.set(qn("w:fldCharType"), "begin")
    instr_text = OxmlElement("w:instrText")
    instr_text.set(qn("xml:space"), "preserve")
    instr_text.text = " PAGE "
    fld_char_2 = OxmlElement("w:fldChar")
    fld_char_2.set(qn("w:fldCharType"), "end")
    run._r.extend([fld_char_1, instr_text, fld_char_2])


def add_hyperlink(paragraph, text, url):
    part = paragraph.part
    relationship_id = part.relate_to(
        url,
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
        is_external=True,
    )
    hyperlink = OxmlElement("w:hyperlink")
    hyperlink.set(qn("r:id"), relationship_id)
    run = OxmlElement("w:r")
    run_properties = OxmlElement("w:rPr")
    color = OxmlElement("w:color")
    color.set(qn("w:val"), "1155CC")
    underline = OxmlElement("w:u")
    underline.set(qn("w:val"), "single")
    run_properties.extend([color, underline])
    run.append(run_properties)
    text_node = OxmlElement("w:t")
    text_node.text = text
    run.append(text_node)
    hyperlink.append(run)
    paragraph._p.append(hyperlink)


def add_body(text="", bold_lead=None, italic=False, align=None, space_after=6):
    p = doc.add_paragraph()
    if align is not None:
        p.alignment = align
    if bold_lead and text.startswith(bold_lead):
        first = p.add_run(bold_lead)
        set_run_font(first, bold=True)
        rest = p.add_run(text[len(bold_lead):])
        set_run_font(rest)
    else:
        run = p.add_run(text)
        set_run_font(run)
        run.italic = italic
    p.paragraph_format.space_after = Pt(space_after)
    return p


def add_bullets(items, level=0):
    for item in items:
        p = doc.add_paragraph(style="List Bullet" if level == 0 else "List Bullet 2")
        p.add_run(item)
        p.paragraph_format.space_after = Pt(3)


def add_numbers(items):
    for item in items:
        p = doc.add_paragraph(style="List Number")
        p.add_run(item)
        p.paragraph_format.space_after = Pt(4)


def add_heading(text, level=1):
    p = doc.add_heading(text, level=level)
    p.paragraph_format.keep_with_next = True
    return p


def add_table(headers, rows, widths=None):
    table = doc.add_table(rows=1, cols=len(headers))
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    set_table_borders(table)
    header = table.rows[0]
    set_repeat_table_header(header)
    for index, value in enumerate(headers):
        cell = header.cells[index]
        set_cell_shading(cell, NAVY)
        set_cell_margins(cell)
        cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
        paragraph = cell.paragraphs[0]
        paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
        run = paragraph.add_run(value)
        set_run_font(run, size=9.5, bold=True, color=RGBColor(255, 255, 255))
        if widths:
            cell.width = Inches(widths[index])
    for row_index, values in enumerate(rows):
        row = table.add_row()
        for index, value in enumerate(values):
            cell = row.cells[index]
            if row_index % 2:
                set_cell_shading(cell, PALE_GRAY)
            set_cell_margins(cell)
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
            p = cell.paragraphs[0]
            p.paragraph_format.space_after = Pt(0)
            run = p.add_run(str(value))
            set_run_font(run, size=9)
            if widths:
                cell.width = Inches(widths[index])
    doc.add_paragraph().paragraph_format.space_after = Pt(2)
    return table


def start_part(title, intro):
    doc.add_page_break()
    add_heading(title, 1)
    add_body(intro, space_after=10)


doc = Document()
section = doc.sections[0]
section.top_margin = Inches(0.7)
section.bottom_margin = Inches(0.7)
section.left_margin = Inches(0.75)
section.right_margin = Inches(0.75)
section.page_width = Inches(8.5)
section.page_height = Inches(11)

styles = doc.styles
normal = styles["Normal"]
normal.font.name = "Aptos"
normal._element.rPr.rFonts.set(qn("w:ascii"), "Aptos")
normal._element.rPr.rFonts.set(qn("w:hAnsi"), "Aptos")
normal.font.size = Pt(10.5)
normal.font.color.rgb = BLACK
normal.paragraph_format.line_spacing = 1.08
normal.paragraph_format.space_after = Pt(6)

for style_name, size, before, after in (
    ("Title", 26, 0, 12),
    ("Heading 1", 18, 14, 8),
    ("Heading 2", 14, 11, 6),
    ("Heading 3", 11.5, 8, 4),
):
    style = styles[style_name]
    style.font.name = "Aptos Display" if style_name != "Heading 3" else "Aptos"
    style._element.rPr.rFonts.set(qn("w:ascii"), style.font.name)
    style._element.rPr.rFonts.set(qn("w:hAnsi"), style.font.name)
    style.font.size = Pt(size)
    style.font.bold = True
    style.font.color.rgb = BLACK
    style.paragraph_format.space_before = Pt(before)
    style.paragraph_format.space_after = Pt(after)
    style.paragraph_format.keep_with_next = True

for list_style_name in ("List Bullet", "List Bullet 2", "List Number"):
    style = styles[list_style_name]
    style.font.name = "Aptos"
    style._element.rPr.rFonts.set(qn("w:ascii"), "Aptos")
    style._element.rPr.rFonts.set(qn("w:hAnsi"), "Aptos")
    style.font.size = Pt(10.5)

header = section.header
hp = header.paragraphs[0]
hp.alignment = WD_ALIGN_PARAGRAPH.RIGHT
hr = hp.add_run("JEE Examination Portal  |  Client Operations Guide")
set_run_font(hr, size=8.5, color=MUTED)

footer = section.footer
fp = footer.paragraphs[0]
fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
fr = fp.add_run("Client handover copy  |  Version 1.0  |  Page ")
set_run_font(fr, size=8.5, color=MUTED)
add_page_number(fp)

# Cover
doc.add_paragraph().paragraph_format.space_after = Pt(32)
title = doc.add_paragraph(style="Title")
title.alignment = WD_ALIGN_PARAGRAPH.CENTER
title.add_run("JEE Examination Portal Client Operations Guide")
subtitle = doc.add_paragraph()
subtitle.alignment = WD_ALIGN_PARAGRAPH.CENTER
sr = subtitle.add_run("Administrator Student and System Owner Manual")
set_run_font(sr, size=15, bold=True, color=BLACK)
subtitle.paragraph_format.space_after = Pt(34)

meta = add_table(
    ["Item", "Details"],
    [
        ["Document version", "1.0"],
        ["Verification date", "13 September 2026"],
        ["Prepared for", "Client system owners, examination administrators, proctors, and support staff"],
        ["Application status", "Local release closure complete; isolated staging and deployment controls remain required before live use"],
    ],
    widths=[1.65, 5.15],
)

add_body(
    "This guide explains how to configure, operate, supervise, and support the JEE Examination Portal. "
    "It covers the complete administrator and student experience, including mandatory administrator MFA, "
    "reviewed JSON question import, exam activation, offline recovery, automatic device takeover, results, "
    "exports, audit records, and maintenance controls.",
    space_after=10,
)
add_body(
    "Release position: The application has passed its local code, database, browser, and 80-candidate rehearsal gates. "
    "The client must complete isolated staging, load, restore, hosting-security, monitoring, and incident-response checks before a live examination.",
    bold_lead="Release position:",
)

doc.add_page_break()
add_heading("Contents", 1)
contents = [
    "1  Purpose and operating model",
    "2  Roles and access",
    "3  First time system setup",
    "4  Administrator guide",
    "5  Student guide",
    "6  Exam day operating procedure",
    "7  Common incidents and recovery",
    "8  Security and data handling rules",
    "9  Client acceptance and production handover",
    "10 Quick reference",
]
for item in contents:
    p = doc.add_paragraph()
    p.paragraph_format.left_indent = Inches(0.2)
    p.paragraph_format.space_after = Pt(6)
    r = p.add_run(item)
    set_run_font(r, size=11)

add_heading("How to use this guide", 2)
add_body(
    "System owners should complete Section 3 and Section 9. Examination administrators should use Sections 4 and 6. "
    "Student instructions may be distributed from Section 5. Support and proctoring staff should keep Sections 7 and 10 available during an examination window."
)

start_part(
    "1 Purpose and operating model",
    "The portal is a role-based computer examination system for administering JEE-style MCQ and numerical-answer examinations. "
    "The database, rather than the browser, owns timing, answer-key protection, grading, session ownership, and final submission state.",
)
add_heading("Normal operating sequence", 2)
add_numbers([
    "The system owner configures the Supabase project, applies all migrations, deploys the student-management function, and creates at least two administrator accounts.",
    "An administrator creates classes and sections, then provisions students with initial credentials.",
    "Questions are created manually or imported as reviewed JSON. Diagrams are uploaded separately to private storage.",
    "The administrator selects verified questions, defines the audience and marking scheme, and creates a pending exam.",
    "The administrator runs Preflight. The portal blocks activation if the paper or required assets are incomplete.",
    "The administrator starts the exam. Assigned students can then enter the pre-exam screen and begin their timed sessions.",
    "Student answers autosave to the server. A device-local recovery copy is used during temporary network loss.",
    "The student submits, the timer expires, or an authorized termination finalizes the latest permitted server-confirmed answers.",
    "The administrator ends the examination window, reviews analytics and ranks, and downloads audited CSV or PDF results.",
    "The system owner reviews health, audit events, storage, backups, and incident records before closing the examination cycle.",
])

add_heading("Data ownership", 2)
add_table(
    ["Information", "Authoritative location", "Important behavior"],
    [
        ["Student identity and assignment", "Supabase Auth and student roster", "Students can access only their own authorized row and assignment"],
        ["Question bank", "Protected PostgreSQL tables and private storage", "Reusable source content; not disclosed to students before an exam starts"],
        ["Exam paper", "Server-owned exam snapshot", "Existing papers are insulated from later Question Bank cleanup"],
        ["Answers in progress", "Versioned active session", "Autosave uses optimistic version checks and server time"],
        ["Offline copy", "Current browser profile on the same device", "Recovery aid only; it does not replace the server record"],
        ["Submitted result", "Immutable result record", "Repeated submission returns the same committed result"],
        ["Administrative actions", "Retained audit trail", "Sensitive actions are attributed without storing passwords, tokens, or answer content"],
    ],
    widths=[1.65, 2.15, 3.0],
)

start_part(
    "2 Roles and access",
    "The portal separates system ownership, examination administration, student use, and operational support. Shared administrator accounts should not be used.",
)
add_table(
    ["Role", "Permitted work", "Restrictions"],
    [
        ["System owner", "Project configuration, migrations, secrets, first administrator, backups, restore, monitoring, incident ownership", "Uses server credentials only from a trusted environment; does not expose secret keys to the browser"],
        ["AAL2 administrator", "Classes, students, questions, imports, exams, results, exports, health, audit, controlled maintenance", "Must sign in with password and verified TOTP; every privileged action is checked again by the server"],
        ["AAL1 administrator", "Complete TOTP enrollment or challenge", "Cannot read protected admin data or mutate the examination system"],
        ["Student", "View assigned exams, start or resume one authorized attempt, answer, submit, and view own result", "Cannot read answer keys, other students, audit data, or administrative objects"],
        ["Service role", "Server-only provisioning and operations", "Must never appear in browser code, screenshots, client-side environment variables, or shared documents"],
    ],
    widths=[1.4, 3.15, 2.25],
)

add_heading("Account policy", 2)
add_bullets([
    "Create a named administrator account for each authorized operator.",
    "Maintain at least two verified administrator accounts with TOTP on separate controlled devices.",
    "Use a unique password of at least 12 characters. The client should apply its institutional password standard if stronger.",
    "Do not send passwords and TOTP enrollment secrets in the same channel.",
    "Deactivate student access when a learner leaves the institution; results remain retained.",
    "Review administrator audit events after every examination cycle.",
])

start_part(
    "3 First time system setup",
    "A system owner performs this section once for each environment. Use separate Supabase projects and secrets for development, staging, and production.",
)
add_heading("Required platform configuration", 2)
add_numbers([
    "Install the supported Node.js runtime and restore the locked dependencies with npm ci.",
    "Configure the browser application with only the Supabase project URL and public publishable or anonymous key.",
    "Apply every SQL file in the migrations directory in timestamp order. Do not edit an already applied migration.",
    "Deploy the manage-student Edge Function with JWT verification enabled.",
    "Disable public registration. Configure a strong Auth password policy and sign-in throttling.",
    "Set ALLOWED_ORIGINS for the Edge Function to the exact application origins. Missing or unrecognized origins are rejected.",
    "Configure private storage, backups, monitoring, hosting headers, and rate limits before production approval.",
])

add_heading("Create the first administrator", 2)
add_body(
    "There are no default administrator credentials. Run the supplied bootstrap from a trusted PowerShell session and choose the administrator email, display name, and password. "
    "The service role or server secret key is required only for this trusted server-side operation."
)
code_lines = [
    '$env:SUPABASE_URL = "https://YOUR_PROJECT_REF.supabase.co"',
    '$env:BOOTSTRAP_ADMIN_EMAIL = "admin@yourinstitution.edu"',
    '$env:BOOTSTRAP_ADMIN_NAME = "Primary Administrator"',
    '$serviceKey = Read-Host "Paste the server service-role or secret key" -AsSecureString',
    '$adminPassword = Read-Host "Choose an administrator password" -AsSecureString',
    '$env:SUPABASE_SERVICE_ROLE_KEY = [System.Net.NetworkCredential]::new("", $serviceKey).Password',
    '$env:BOOTSTRAP_ADMIN_PASSWORD = [System.Net.NetworkCredential]::new("", $adminPassword).Password',
    'npm run admin:bootstrap',
]
for line in code_lines:
    p = doc.add_paragraph()
    p.paragraph_format.left_indent = Inches(0.3)
    p.paragraph_format.space_after = Pt(1)
    r = p.add_run(line)
    set_run_font(r, name="Consolas", size=9)
add_body(
    "After the command succeeds, remove the temporary environment variables from the terminal session. Never store the server secret in a VITE-prefixed variable or commit it to the repository.",
    space_after=8,
)

add_heading("Enroll administrator MFA", 2)
add_numbers([
    "Open the portal and select the Administrator tab.",
    "Enter the bootstrapped administrator email and password.",
    "On first sign-in, scan the displayed QR code using an approved authenticator application.",
    "Enter the current six-digit code and select Verify and Continue.",
    "Confirm that the Admin Portal opens. A password-only session must remain blocked.",
    "Repeat the bootstrap and enrollment process for a second named administrator.",
])

add_heading("Configuration files", 2)
add_table(
    ["Setting", "Location", "Handling rule"],
    [
        ["VITE_SUPABASE_URL", "Browser deployment environment", "Public project endpoint"],
        ["VITE_SUPABASE_ANON_KEY", "Browser deployment environment", "Public client key; RLS still controls access"],
        ["SUPABASE_SERVICE_ROLE_KEY", "Trusted operator or server environment", "Secret; never expose to a browser"],
        ["ALLOWED_ORIGINS", "manage-student function secrets", "Comma-separated exact HTTPS origins"],
        ["Administrator password", "Institution credential manager", "Named account; never store in source"],
        ["TOTP factor", "Administrator-controlled authenticator", "Maintain tested recovery ownership"],
    ],
    widths=[2.0, 2.35, 2.45],
)

start_part(
    "4 Administrator guide",
    "Administrators use seven areas in the left navigation: Dashboard, Students, Classes, Question Bank, Reviewed JSON Import, Operations and Audit, and Database Cleaner.",
)
add_heading("Sign in and sign out", 2)
add_numbers([
    "Select Administrator on the Exam Portal sign-in page.",
    "Enter the administrator email and password.",
    "Enter the six-digit authenticator code when prompted. First-time users complete QR-code enrollment instead.",
    "Verify the header shows Administrator before making changes.",
    "Select Logout when work is complete. Do not leave an AAL2 session unattended.",
])

add_heading("Dashboard", 2)
add_body(
    "Dashboard Overview lists examinations in server-paged cards. Search by title, class, or section and filter by Pending, Active, or Ended. "
    "Open Manage and Results to view the complete exam record, controls, paper archive, analytics, leaderboard, and exports."
)
add_bullets([
    "Pending means the paper exists but students cannot start it.",
    "Active means assigned students can start or resume.",
    "Ended means new starts are blocked. Results and the paper remain retained.",
    "If loading fails, use the visible retry action. Do not treat stale data as complete.",
])

add_heading("Classes", 2)
add_numbers([
    "Open Classes.",
    "Enter a class name and comma-separated sections, such as JEE 2027 and A, B, C.",
    "Select Create Class.",
    "Use Delete only for an empty class. The portal requires the exact class name and blocks deletion while students or exams reference it.",
])

add_heading("Students", 2)
add_numbers([
    "Create the required class and section first.",
    "Open Students and enter Student Name, Student ID, a 12-character-or-longer initial password, Class, and Section.",
    "Select Add Student and wait for the success message. The server creates both the Auth account and roster row or rolls back the operation.",
    "Give the student the ID and password using the institution's approved credential-delivery process.",
    "Use search, class and section filters, and paging to find accounts.",
    "Change the class or section only while the account is active.",
    "Use Deactivate with a reason when access must stop. Results are retained. Use Reactivate after authorization to restore access.",
])
add_body(
    "Important: A deactivated student cannot sign in or use exam functions. Deactivation is the normal account-removal workflow; it avoids destroying academic records.",
    bold_lead="Important:",
)

add_heading("Question Bank manual entry", 2)
add_numbers([
    "Open Question Bank and choose Create Blank MCQ or Create Blank Numerical NAT.",
    "Select Physics, Chemistry, or Mathematics and enter the question text.",
    "For MCQ, provide four complete, unique options and select the correct option.",
    "For numerical questions, provide a signed decimal answer. Scientific notation, spaces, NaN, and infinity are not accepted. Zero is valid.",
    "If the question or an option needs a diagram, upload the actual image and verify the preview before saving.",
    "Use balanced single-dollar or double-dollar delimiters for mathematical expressions.",
    "Select Save Changes. The portal blocks incomplete or inconsistent content.",
])
add_body(
    "Deleting a reusable Question Bank row does not alter an exam paper that was already created from it. However, administrators should avoid cleanup during paper assembly unless the change is planned and reviewed."
)

add_heading("Reviewed JSON Import", 2)
add_body(
    "This page accepts reviewed JSON only. It does not read PDF, image, OCR, word-processing, or AI files. Convert source documents outside the portal using an approved process."
)
add_numbers([
    "Open Reviewed JSON Import and download the current JSON example and schema.",
    "Prepare one UTF-8 .json file using schema version 1.0. The limit is 5 MB and 500 questions.",
    "Upload the file and review each row's subject, type, prompt, options, correct answer, mathematics, and diagram flag.",
    "Correct blocking diagnostics. Valid rows are not imported until an administrator explicitly approves them.",
    "Select Approve All Valid only after human review, or approve rows individually.",
    "Select Import Approved and confirm. Keep the page open until the server confirms the count and batch identity.",
    "If the response is lost, retry the same batch. The server returns the committed result without duplicating questions.",
    "Attach required diagrams in Question Bank before assembling or activating the exam.",
])

add_heading("Create an exam", 2)
add_numbers([
    "Open Question Bank and search or filter the required questions.",
    "Select each question. Selections can remain active across pages. Review the selected count before creating the paper.",
    "Enter the Exam Title and choose the target Class and Section.",
    "Choose the duration, marks for a correct answer, and negative marks for an incorrect answer.",
    "Select Create Exam. The portal retrieves and verifies the exact selected IDs and creates a pending server-owned snapshot.",
    "Return to Dashboard, open the exam, and review the complete paper archive before activation.",
])

add_heading("Preflight and lifecycle controls", 2)
add_table(
    ["Action", "When to use it", "Server protection"],
    [
        ["Preflight", "After paper assembly and after any corrected asset", "Checks paper structure, subjects, answers, scoring, and physical private-storage assets"],
        ["Start Exam", "At the authorized examination opening time", "Runs Preflight first; students cannot start until status is Active"],
        ["End Exam", "At the scheduled close or authorized early close", "Blocks new starts and preserves attempts/results"],
        ["Delete Exam", "Only for an unused non-active paper", "Requires exact title and confirmation; blocked when results or protected attempts exist"],
        ["Reactivate", "Only where lifecycle rules permit", "Ended exams with submissions or active attempts cannot be silently restarted"],
    ],
    widths=[1.25, 2.55, 3.0],
)

add_heading("Results analytics and exports", 2)
add_body(
    "Open Manage and Results for an exam. The page shows average, highest and lowest scores, distribution charts, subject averages, the retained paper, and a server-ranked leaderboard. "
    "Search by student name or ID and move through pages without downloading the whole roster."
)
add_bullets([
    "Download CSV produces a UTF-8 spreadsheet-safe file and supports the complete verified result set within the configured bounds.",
    "Download PDF produces a printable ranked report and is limited to 2,000 rows. If names contain characters the built-in PDF font cannot render, use CSV.",
    "Exports require AAL2, verify the authoritative result count, and create an administrator audit event.",
    "If a result load is incomplete or changes during preparation, export is blocked rather than producing a misleading partial file.",
])

add_heading("Operations and Audit", 2)
add_body(
    "Operational Health is read-only and shows active exams, live attempts, expired attempts awaiting finalization, questions missing required media, inactive students, and recent audit activity. "
    "Use Refresh Status before and during an exam window."
)
add_bullets([
    "Scan Unreferenced Assets lists files that are not referenced by an exam or Question Bank row.",
    "Purge only after reviewing the list. Referenced assets remain protected.",
    "The Recent Administrator Audit Trail shows the latest 100 retained server events, newest first.",
    "Audit metadata must not be used to store passwords, tokens, answers, or question content.",
])

add_heading("Database Cleaner", 2)
add_body(
    "Database Cleaner is a controlled maintenance screen, not a general deletion tool. Results, exams, students, classes, and import history are protected from bulk deletion."
)
add_table(
    ["Record area", "Available maintenance"],
    [
        ["Exam Results", "Protected immutable academic records"],
        ["Active Student Sessions", "Finalize expired attempts from the last server-confirmed answers; live attempts remain"],
        ["Exams and Schedules", "No bulk deletion; delete only an eligible unused exam from Exam Management"],
        ["Question Bank", "Clear reusable questions after typed confirmation; existing exam snapshots remain"],
        ["Student Roster", "No bulk deletion; deactivate accounts from Students"],
        ["Classes and Sections", "Delete only an empty unreferenced class individually"],
        ["Import History", "Protected retained operational record"],
    ],
    widths=[2.15, 4.65],
)

start_part(
    "5 Student guide",
    "Students sign in with the Student tab, their assigned Student ID, and password. They do not create their own accounts and do not use administrator MFA.",
)
add_heading("Sign in and view assigned exams", 2)
add_numbers([
    "Open the portal and select Student.",
    "Enter the Student ID exactly as issued and enter the password.",
    "Confirm the dashboard shows the correct student name, class, and section.",
    "Review Your Assigned Examinations. Pending exams show Waiting for Admin to Start. Active exams show Start Exam or Resume Exam. Completed exams show View Result.",
    "If the exam list cannot refresh, keep the page open, restore connectivity, and select Retry.",
])

add_heading("Automatic device takeover", 2)
add_body(
    "The newest successful student login becomes the only device allowed to change the attempt. If another device was already signed in, the new device displays a takeover warning. "
    "It can resume only the latest answer set confirmed by the server. Answers saved only in the old device's offline storage do not transfer."
)
add_bullets([
    "Use takeover only when the previous device is unavailable or has failed.",
    "The old device becomes read-only after the server rejects it, keeps its local recovery copy, and signs out.",
    "Do not alternate between devices. Choose one device and remain on it for the rest of the examination.",
])

add_heading("Pre-exam checks", 2)
add_numbers([
    "Select Start Exam or Resume Exam.",
    "Confirm the Browser and Device Verified message. The exam cannot start if required recovery storage is unavailable.",
    "Read the duration, subjects, marking scheme, and security warning.",
    "Use a desktop, tablet, or landscape orientation for the clearest formulas and question navigation.",
    "Select I have read and understood the instructions.",
    "Wait for the administrator to activate the exam, then select Start Exam.",
    "Allow fullscreen mode and keep the examination tab in the foreground.",
])

add_heading("Exam screen", 2)
add_table(
    ["Area", "What it shows", "How to use it"],
    [
        ["Top bar", "Exam title, save state, network state, and server-based time remaining", "Watch for Saved; reconnect promptly if Saved Offline or Save Failed appears"],
        ["Subject tabs", "Physics, Chemistry, Mathematics, or the subjects configured for the paper", "Move between subjects without submitting"],
        ["Question panel", "Prompt, diagrams, answer control, and action buttons", "Choose one MCQ option or enter one valid signed decimal for a numerical question"],
        ["Question palette", "Question numbers and status legend", "Select any number to move directly; status includes visited, answered, review, and unanswered states"],
        ["Navigation", "Back, Next, Save and Next, review, clear, and submit actions", "Save before moving when an answer should be retained"],
    ],
    widths=[1.3, 2.45, 3.05],
)

add_heading("Answer actions", 2)
add_bullets([
    "Save and Next stores the current response and moves forward.",
    "Save and Mark for Review stores the response and flags the question for later review.",
    "Clear Response removes the saved response for that question.",
    "Mark for Review and Next flags the question without saving a new response.",
    "Back and Next move between questions. Keyboard shortcuts shown on the buttons are also supported.",
    "Submit Exam opens a confirmation dialog. Submit only after reviewing the palette and time remaining.",
])

add_heading("Save and network indicators", 2)
add_table(
    ["Indicator", "Meaning", "Student action"],
    [
        ["Saved", "All current responses are confirmed by the server", "Continue normally"],
        ["Saving", "An update is being sent", "Wait briefly before closing or submitting"],
        ["Saved Offline", "A local recovery copy exists but the server has not confirmed the newest work", "Keep the page open and reconnect"],
        ["Retrying", "The portal is attempting to synchronize", "Do not refresh repeatedly or switch devices"],
        ["Save Failed", "Neither normal synchronization nor the current retry completed", "Notify the proctor and preserve the browser window"],
    ],
    widths=[1.25, 3.05, 2.5],
)

add_heading("If the internet disconnects", 2)
add_numbers([
    "Keep the exam tab open. The official timer continues.",
    "Read the Internet Connection Dropped message and confirm whether a local recovery copy is active.",
    "Select Continue Answering Offline when local recovery is available.",
    "Reconnect the same device as soon as possible. The portal retries the latest version against the server.",
    "Do not assume the three-minute grace period is extra answering time. It exists only to deliver a submission request after the answer deadline.",
    "If the timer reaches zero, the server grades only answers it confirmed within the allowed deadline rules.",
])

add_heading("Submit and view results", 2)
add_numbers([
    "Select Submit Exam and confirm once.",
    "Wait for the result screen. If the response is lost after the server commits, the portal looks up and returns the same committed result instead of creating another result.",
    "Review Total Score, correct, incorrect, unattempted, and subject-wise marks.",
    "Select Return to Dashboard. Use View Result later to revisit the retained result.",
])

add_heading("Security violations", 2)
add_body(
    "The exam requires fullscreen. Leaving fullscreen, navigating away, switching tabs, or using prohibited shortcuts may create a verified violation. "
    "Repeated violations can terminate the attempt. Termination finalizes the answers confirmed by the server before the violation."
)

start_part(
    "6 Exam day operating procedure",
    "Use this sequence as the administrator and proctor checklist. Record the person responsible for each item in the client's own run sheet.",
)
add_heading("Seven days before the exam", 2)
add_bullets([
    "Confirm the staging rehearsal, restore drill, load test, hosting headers, monitoring, and incident contacts are approved.",
    "Verify at least two administrator accounts and their TOTP devices.",
    "Create or review classes, sections, and the student roster.",
    "Import or author questions and attach all required diagrams.",
    "Create the pending exam and independently review title, audience, duration, marking, subjects, and total questions.",
])

add_heading("One day before the exam", 2)
add_bullets([
    "Run Preflight and resolve every error.",
    "Use Operations and Audit to verify health and missing-media counts.",
    "Review the complete paper archive with an authorized academic reviewer.",
    "Confirm backup status, storage capacity, rate-limit settings, and alert routing.",
    "Test one representative student account on the intended network and device type.",
])

add_heading("Sixty minutes before the exam", 2)
add_bullets([
    "Sign in as a named AAL2 administrator and refresh Operational Health.",
    "Confirm no unexplained live or expired attempts exist.",
    "Ask students to sign in and remain on the pre-exam instruction screen.",
    "Verify proctors know the offline, takeover, violation, and escalation procedures.",
    "Start the exam only at the authorized opening time and confirm the status changes to Active.",
])

add_heading("During the exam", 2)
add_bullets([
    "Keep one administrator signed in on a secured control device and one backup administrator available.",
    "Monitor Operational Health, connectivity, and candidate reports without exposing student answers.",
    "Do not edit the active paper, duration, marks, or audience. The database blocks protected mutations.",
    "For a failed student device, decide whether automatic takeover is acceptable after explaining that offline-only answers cannot move.",
    "Record incidents, candidate identity, device, time, action, and outcome outside the portal according to institutional policy.",
])

add_heading("After the exam", 2)
add_bullets([
    "End the exam at the authorized close.",
    "Finalize only expired attempts from Database Cleaner if Operational Health reports them.",
    "Confirm the expected result count and investigate discrepancies before export.",
    "Download audited CSV or PDF results using a controlled administrator device.",
    "Review recent administrator audit events and storage assets.",
    "Store exported files according to institutional retention and privacy policy.",
    "Close the incident log and record any follow-up actions before the next examination.",
])

start_part(
    "7 Common incidents and recovery",
    "The safest response is to preserve the current browser and server state, identify the authoritative result, and avoid repeated destructive actions.",
)
add_table(
    ["Situation", "Immediate response", "Do not"],
    [
        ["Student loses internet", "Keep the same tab open, continue offline if offered, and reconnect the same device", "Do not treat grace as extra time or immediately move to another device"],
        ["Browser closes or device loses power", "Restart the same browser profile and use Resume Exam; notify the proctor", "Do not clear browser storage"],
        ["Student must use a new device", "Sign in once, accept takeover warning, and resume the latest server-confirmed autosave", "Do not expect offline-only answers from the old device"],
        ["Old device reconnects after takeover", "Allow the portal to become read-only and sign out", "Do not attempt autosave or submit from the old device"],
        ["Submit response is unclear", "Keep the page open and allow the portal to retrieve the committed result or retry idempotently", "Do not create a second student account or clear local recovery"],
        ["Exam will not activate", "Run Preflight, read each error, fix paper structure or missing assets, then rerun", "Do not bypass the database guard"],
        ["Student cannot sign in", "Verify exact ID, active roster status, class assignment, password delivery, and network", "Do not expose administrator or service credentials"],
        ["Administrator loses TOTP device", "Use the documented MFA recovery procedure with an authorized recovery operator and a second admin", "Do not delete the last working factor without a tested recovery path"],
        ["Expired attempts remain", "Use Finalize Expired Attempts; live attempts remain untouched", "Do not clear the active sessions table directly"],
        ["Results look incomplete", "Refresh, verify the authoritative count, inspect health and audit records, then export", "Do not distribute a partial export"],
    ],
    widths=[1.55, 3.45, 1.8],
)

add_heading("Escalation information to collect", 2)
add_bullets([
    "Environment and application URL",
    "Student ID or administrator email, without the password",
    "Exam title and approximate incident time",
    "Device type, operating system, browser, and network",
    "Visible error message and save/network indicator",
    "Whether another device or tab was used",
    "Whether the result screen appeared",
    "Relevant administrator audit event ID and operational-health status",
])
add_body(
    "Never collect passwords, TOTP codes, access tokens, service keys, complete answer content, or private question papers in a support ticket."
)

start_part(
    "8 Security and data handling rules",
    "These rules are part of operating the portal safely and should be incorporated into the client's examination policy.",
)
add_bullets([
    "Keep public registration disabled. Students must be provisioned by an AAL2 administrator through the server function.",
    "Never place a service-role or server secret key in browser code, VITE variables, email, chat, screenshots, or client documentation.",
    "Use named administrator accounts and mandatory TOTP. Review and revoke access promptly when responsibilities change.",
    "Do not modify existing migration files. Apply corrections through new forward-only migrations.",
    "Do not expose raw papers, answer keys, audit metadata, or private storage through ad hoc views or RPCs.",
    "Do not delete submitted results. They are retained academic records.",
    "Treat downloaded CSV and PDF files as personal academic data. Store, transmit, and delete them under the client's approved policy.",
    "Use only reviewed JSON for question import. Do not tell users the portal parses PDF, OCR, images, or AI output.",
    "Run Preflight before every activation and after any media correction.",
    "Record and rehearse backup, restore, MFA recovery, outage response, and incident communications.",
])

add_heading("Supported operational boundaries", 2)
add_table(
    ["Boundary", "Portal behavior"],
    [
        ["Maximum questions per exam", "500"],
        ["Reviewed JSON file", "One .json file, no more than 5 MB and 500 questions"],
        ["Numerical response", "Signed decimal text; scientific notation and spaces rejected"],
        ["Offline recovery", "Same browser profile and student account; server time continues"],
        ["Submission recovery grace", "180 seconds to deliver a submission request; no extra answering time"],
        ["PDF result export", "Maximum 2,000 rows and restricted font coverage"],
        ["Audit display", "Latest 100 retained administrator events"],
        ["Automatic takeover", "Newest login replaces old device; offline-only old-device answers do not transfer"],
    ],
    widths=[2.2, 4.6],
)

start_part(
    "9 Client acceptance and production handover",
    "The local application has completed its implementation plan. Production approval depends on evidence from the client's actual staging and hosting environment.",
)
add_heading("Local verification evidence", 2)
add_table(
    ["Gate", "Result"],
    [
        ["Forward-only migrations", "60 migrations rebuild successfully from an empty local database"],
        ["Database advisor", "Zero schema warnings"],
        ["Automated repository tests", "233 of 233 passed across 37 test files"],
        ["Authenticated browser matrix", "26 of 26 passed across Chromium and WebKit"],
        ["Critical browser gate", "14 of 14 passed across Chromium and WebKit"],
        ["80-candidate local rehearsal", "Zero lost or cross-account answers, duplicate results, unauthorized operations, or unhandled server errors"],
        ["Build and dependency audit", "Production build passed; zero known dependency vulnerabilities"],
        ["Operational health", "Healthy after rehearsal"],
    ],
    widths=[2.45, 4.35],
)

add_heading("Required staging evidence", 2)
add_numbers([
    "Apply all migrations from an empty isolated staging database and rerun database advisors.",
    "Run the guarded 80-candidate rehearsal using staging secrets and confirm exact session and result counts.",
    "Obtain passing Linux CI results for Chromium, Firefox, and WebKit. Local Firefox could not launch on the Windows verification host because of a host side-by-side assembly error before application code ran.",
    "Run peak, soak, reconnect-storm, simultaneous-login, autosave, and simultaneous-submit load at the expected institutional concurrency.",
    "Restore the database and private storage from backup and record measured recovery point and recovery time objectives.",
    "Verify administrator MFA recovery, service outage response, emergency termination, rollback, and candidate communication.",
    "Complete supported-device and assisted screen-reader acceptance with representative users.",
])

add_heading("Required deployment controls", 2)
add_bullets([
    "HTTPS and domain configuration",
    "Content Security Policy, HSTS, frame restrictions, Referrer Policy, Permissions Policy, MIME sniffing protection, and correct caching",
    "Separate staging and production projects, keys, domains, and operator access",
    "Measured Auth, REST, RPC, Edge Function, Storage, and perimeter rate limits",
    "Backups or PITR, restore monitoring, storage recovery, retention, and privacy governance",
    "Centralized errors and logs, availability and latency alerts, audit alerts, capacity dashboards, and on-call routing",
    "Named incident owners, rollback criteria, communications, and periodic drills",
])

add_heading("Production approval record", 2)
add_table(
    ["Approval", "Name", "Date", "Evidence reference"],
    [
        ["Academic owner", "", "", ""],
        ["Security owner", "", "", ""],
        ["Infrastructure owner", "", "", ""],
        ["Examination operations owner", "", "", ""],
        ["Accessibility owner", "", "", ""],
        ["Final release authority", "", "", ""],
    ],
    widths=[2.0, 1.6, 1.0, 2.2],
)

start_part(
    "10 Quick reference",
    "Use these final checks during normal administration and student support.",
)
add_heading("Administrator daily checklist", 2)
add_bullets([
    "Sign in with a named account and TOTP.",
    "Check Operational Health and recent audit events.",
    "Confirm the correct environment before any change.",
    "Run Preflight before starting an exam.",
    "Do not edit an active paper or distribute incomplete results.",
    "End the exam, verify result count, export through the audited controls, and sign out.",
])

add_heading("Student quick instructions", 2)
add_bullets([
    "Use the issued Student ID and password on the Student tab.",
    "Use one device and one browser profile.",
    "Read the pre-exam instructions, verify storage, and enter fullscreen.",
    "Watch Saved and the server-based timer.",
    "If offline, keep the tab open and reconnect the same device.",
    "A new-device takeover restores only server-confirmed work.",
    "Submit once and wait for the result screen.",
])

add_heading("Reference documents", 2)
references = [
    ("Setup and Release Guide", "SETUP.md in the project root"),
    ("Reviewed JSON Import", "docs/REVIEWED_JSON_IMPORT.md"),
    ("Operations and Disaster Recovery", "docs/OPERATIONS_AND_DISASTER_RECOVERY.md"),
    ("Administrator MFA Recovery", "docs/mfa-recovery-runbook.md"),
    ("Authorization Manifest", "docs/STAGE21_AUTHORIZATION_MANIFEST.md"),
    ("Production Readiness Report", "PRODUCTION_READINESS_REPORT.md"),
    ("Production Readiness Security Audit", "PRODUCTION_READINESS_AUDIT_2026-09-10.md"),
]
add_table(["Document", "Location"], references, widths=[2.65, 4.15])

add_heading("Official platform references", 2)
p = doc.add_paragraph()
p.add_run("Supabase administrator user creation: ")
add_hyperlink(p, "supabase.com/docs/reference/javascript/auth-admin-createuser", "https://supabase.com/docs/reference/javascript/auth-admin-createuser")
p2 = doc.add_paragraph()
p2.add_run("Supabase TOTP MFA: ")
add_hyperlink(p2, "supabase.com/docs/guides/auth/auth-mfa/totp", "https://supabase.com/docs/guides/auth/auth-mfa/totp")

add_body(
    "End of guide. The client should update organization names, support contacts, retention periods, examination rules, and approval owners before distribution. "
    "Do not add credentials or server secrets to this document.",
    space_after=0,
)

# Keep table rows together where practical and normalize run fonts.
for table in doc.tables:
    for row in table.rows:
        for cell in row.cells:
            for paragraph in cell.paragraphs:
                for run in paragraph.runs:
                    if not run.font.name:
                        set_run_font(run)

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
doc.save(OUTPUT)
print(OUTPUT)
