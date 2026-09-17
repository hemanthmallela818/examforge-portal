from pathlib import Path
from xml.sax.saxutils import escape

import pypdfium2 as pdfium
from docx import Document
from docx.table import Table as DocxTable
from docx.text.paragraph import Paragraph as DocxParagraph
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    LongTable,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    TableStyle,
)


SOURCE = Path(r"C:\Users\heman\Downloads\CBT\MockTest-main\docs\JEE_Examination_Portal_Client_Operations_Guide.docx")
OUTPUT = Path(r"C:\Users\heman\Downloads\CBT\MockTest-main\output\pdf\JEE_Examination_Portal_Client_Operations_Guide.pdf")
RENDER_DIR = Path(r"C:\Users\heman\Downloads\CBT\MockTest-main\tmp\client-guide-pdf-render")

NAVY = colors.HexColor("#1E3A5F")
LIGHT_BLUE = colors.HexColor("#EAF2F8")
PALE_GRAY = colors.HexColor("#F5F7FA")
BORDER = colors.HexColor("#D9D9D9")
MUTED = colors.HexColor("#4B5563")


def iter_blocks(document):
    body = document.element.body
    for child in body.iterchildren():
        if child.tag.endswith("}p"):
            yield DocxParagraph(child, document)
        elif child.tag.endswith("}tbl"):
            yield DocxTable(child, document)


def paragraph_text(paragraph):
    return "".join(node.text or "" for node in paragraph._p.iter() if node.tag.endswith("}t"))


def has_page_break(paragraph):
    for node in paragraph._p.iter():
        if node.tag.endswith("}br") and node.get("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}type") == "page":
            return True
    return False


def on_page(canvas, document):
    canvas.saveState()
    width, height = letter
    page_number = canvas.getPageNumber()
    if page_number > 1:
        canvas.setFont("Helvetica", 8)
        canvas.setFillColor(MUTED)
        canvas.drawRightString(width - 0.7 * inch, height - 0.38 * inch, "JEE Examination Portal  |  Client Operations Guide")
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(MUTED)
    canvas.drawCentredString(width / 2, 0.38 * inch, f"Client handover copy  |  Version 1.0  |  Page {page_number}")
    canvas.restoreState()


styles = getSampleStyleSheet()
body = ParagraphStyle(
    "ClientBody",
    parent=styles["BodyText"],
    fontName="Helvetica",
    fontSize=9.5,
    leading=12,
    textColor=colors.black,
    spaceAfter=6,
    allowWidows=0,
    allowOrphans=0,
)
title_style = ParagraphStyle(
    "ClientTitle",
    parent=body,
    fontName="Helvetica-Bold",
    fontSize=24,
    leading=29,
    alignment=TA_CENTER,
    spaceAfter=16,
)
subtitle_style = ParagraphStyle(
    "ClientSubtitle",
    parent=body,
    fontName="Helvetica-Bold",
    fontSize=14,
    leading=18,
    alignment=TA_CENTER,
    spaceAfter=28,
)
h1 = ParagraphStyle(
    "ClientH1",
    parent=body,
    fontName="Helvetica-Bold",
    fontSize=17,
    leading=21,
    spaceBefore=8,
    spaceAfter=9,
    keepWithNext=True,
)
h2 = ParagraphStyle(
    "ClientH2",
    parent=body,
    fontName="Helvetica-Bold",
    fontSize=13,
    leading=16,
    spaceBefore=9,
    spaceAfter=6,
    keepWithNext=True,
)
h3 = ParagraphStyle(
    "ClientH3",
    parent=body,
    fontName="Helvetica-Bold",
    fontSize=11,
    leading=14,
    spaceBefore=7,
    spaceAfter=4,
    keepWithNext=True,
)
bullet = ParagraphStyle(
    "ClientBullet",
    parent=body,
    fontSize=9.4,
    leading=11.7,
    leftIndent=18,
    firstLineIndent=-10,
    spaceAfter=1.5,
)
bullet2 = ParagraphStyle(
    "ClientBullet2",
    parent=body,
    fontSize=9.4,
    leading=11.7,
    leftIndent=34,
    firstLineIndent=-10,
    spaceAfter=1.5,
)
numbered = ParagraphStyle(
    "ClientNumbered",
    parent=body,
    leftIndent=20,
    firstLineIndent=-14,
    spaceAfter=3,
)
closing_bullet = ParagraphStyle(
    "ClientClosingBullet",
    parent=bullet,
    fontSize=8.8,
    leading=10,
    spaceAfter=0,
)
code_style = ParagraphStyle(
    "ClientCode",
    parent=body,
    fontName="Courier",
    fontSize=7.7,
    leading=10,
    leftIndent=18,
    spaceAfter=1,
)
contents_style = ParagraphStyle(
    "ClientContents",
    parent=body,
    fontSize=10.5,
    leading=14,
    leftIndent=12,
    spaceAfter=4,
)


def table_widths(column_count):
    usable = 7.08 * inch
    if column_count == 2:
        return [usable * 0.34, usable * 0.66]
    if column_count == 3:
        return [usable * 0.23, usable * 0.38, usable * 0.39]
    if column_count == 4:
        return [usable * 0.27, usable * 0.23, usable * 0.15, usable * 0.35]
    return [usable / column_count] * column_count


document = Document(SOURCE)
story = []
number_counter = 0

for block in iter_blocks(document):
    if isinstance(block, DocxParagraph):
        text = paragraph_text(block).strip()
        style_name = block.style.name if block.style is not None else "Normal"
        if has_page_break(block):
            if story and not isinstance(story[-1], PageBreak):
                story.append(PageBreak())
            number_counter = 0
            continue
        if not text:
            story.append(Spacer(1, 4))
            number_counter = 0
            continue

        # Keep the two closely related release-close instructions together so
        # the final checklist item is not stranded on a continuation page.
        if text in {
            "Close the incident log and record any follow-up actions before the next examination.",
            "Finalize only expired attempts from Database Cleaner if Operational Health reports them.",
            "Download audited CSV or PDF results using a controlled administrator device.",
        }:
            continue
        if text == "End the exam at the authorized close.":
            text += " Finalize only expired attempts from Database Cleaner when Operational Health reports them."
        if text == "Confirm the expected result count and investigate discrepancies before export.":
            text += " Then download the audited CSV or PDF from a controlled administrator device."
        if text == "Store exported files according to institutional retention and privacy policy.":
            text += " Close the incident log and record any follow-up actions before the next examination."

        safe = escape(text)
        if style_name == "Title":
            story.append(Spacer(1, 0.45 * inch))
            story.append(Paragraph(safe, title_style))
        elif text == "Administrator Student and System Owner Manual":
            story.append(Paragraph(safe, subtitle_style))
        elif style_name == "Heading 1":
            story.append(Paragraph(safe, h1))
            number_counter = 0
        elif style_name == "Heading 2":
            story.append(Paragraph(safe, h2))
            number_counter = 0
        elif style_name == "Heading 3":
            story.append(Paragraph(safe, h3))
            number_counter = 0
        elif style_name == "List Bullet":
            selected_bullet_style = closing_bullet if text.startswith("Store exported files according to institutional retention") else bullet
            story.append(Paragraph(f"- {safe}", selected_bullet_style))
            number_counter = 0
        elif style_name == "List Bullet 2":
            story.append(Paragraph(f"- {safe}", bullet2))
            number_counter = 0
        elif style_name == "List Number":
            number_counter += 1
            story.append(Paragraph(f"{number_counter}. {safe}", numbered))
        elif text.startswith("$env:") or text.startswith("$serviceKey") or text.startswith("$adminPassword") or text.startswith("npm run"):
            story.append(Paragraph(safe, code_style))
        elif text[:2].isdigit() and text[2:3] == " ":
            story.append(Paragraph(safe, contents_style))
            number_counter = 0
        else:
            story.append(Paragraph(safe, body))
            number_counter = 0
    else:
        raw_rows = []
        for row in block.rows:
            values = []
            for cell in row.cells:
                value = " ".join(part.strip() for part in cell.text.splitlines() if part.strip())
                values.append(Paragraph(escape(value), body))
            raw_rows.append(values)
        if not raw_rows:
            continue
        table = LongTable(raw_rows, colWidths=table_widths(len(raw_rows[0])), repeatRows=1, hAlign="CENTER")
        table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), NAVY),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("ALIGN", (0, 0), (-1, 0), "CENTER"),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("GRID", (0, 0), (-1, -1), 0.5, BORDER),
            ("LEFTPADDING", (0, 0), (-1, -1), 7),
            ("RIGHTPADDING", (0, 0), (-1, -1), 7),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ]))
        for row_index in range(1, len(raw_rows)):
            if row_index % 2 == 0:
                table.setStyle(TableStyle([("BACKGROUND", (0, row_index), (-1, row_index), PALE_GRAY)]))
        story.append(table)
        number_counter = 0

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
pdf = SimpleDocTemplate(
    str(OUTPUT),
    pagesize=letter,
    rightMargin=0.7 * inch,
    leftMargin=0.7 * inch,
    topMargin=0.62 * inch,
    bottomMargin=0.62 * inch,
    title="JEE Examination Portal Client Operations Guide",
    author="Client handover",
    subject="Administrator student and system owner operating manual",
)
pdf.build(story, onFirstPage=on_page, onLaterPages=on_page)

RENDER_DIR.mkdir(parents=True, exist_ok=True)
for old in RENDER_DIR.glob("page-*.png"):
    old.unlink()
rendered = pdfium.PdfDocument(str(OUTPUT))
for index in range(len(rendered)):
    page = rendered[index]
    bitmap = page.render(scale=1.7)
    bitmap.to_pil().save(RENDER_DIR / f"page-{index + 1:03d}.png")
    page.close()
rendered.close()

print(f"PDF={OUTPUT}")
print(f"PAGES={len(list(RENDER_DIR.glob('page-*.png')))}")
