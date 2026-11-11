/* Reports as PDF files (Reports > a report > Report Format PDF).
   The report shown on the page (#reportOutput) is turned into a real PDF with jsPDF (vendor/jspdf.umd.min.js and
   vendor/jspdf.plugin.autotable.min.js): the college letterhead with its logo, the report's title and date, its
   filters, the summary boxes, then each section and table; page numbers at the bottom. It opens in a viewer on the
   page (the browser's own PDF viewer: pages, zoom, print, download), with Open in new tab, Download and Close.
   The PDF is only made in the browser's memory while it is open; nothing is saved on the computer unless
   Download is pressed. */

const PDF_PURPLE = [49, 24, 77];
const PDF_GOLD = [223, 177, 91];
const PDF_TITLE = [128, 0, 32];
const PDF_GREY = [90, 90, 90];
let pdfViewerUrl = null;
let pdfViewerName = 'Report.pdf';

// The standard PDF fonts only have Western letters: ticks and crosses become Yes / No, other signs are dropped
function pdfText(text) {
    return String(text ?? '')
        .replace(/✓/g, 'Yes').replace(/✗/g, 'No').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
        .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF–—•…€]/g, '')
        .replace(/[ \t]+/g, ' ').trim();
}

// A picture on the page as data the PDF can hold (a JPEG), or null when it cannot be read
function pdfImage(img) {
    try {
        if (!img || !img.complete || !img.naturalWidth) return null;
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const context = canvas.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(img, 0, 0);
        return { data: canvas.toDataURL('image/jpeg', 0.85), ratio: img.naturalWidth / img.naturalHeight };
    } catch {
        return null;
    }
}

// Waits (at most 3 seconds) for the report's pictures to finish loading
async function pdfImagesLoaded(root) {
    const images = [...root.querySelectorAll('img')].filter(img => img.src && !img.complete);
    await Promise.race([
        Promise.all(images.map(img => new Promise(done => { img.onload = img.onerror = done; }))),
        new Promise(done => setTimeout(done, 3000))
    ]);
}

// Builds the PDF from the report shown on the page
async function buildReportPdf(title) {
    const output = document.getElementById('reportOutput');
    await pdfImagesLoaded(output);
    const parts = [...output.children].filter(el => el.offsetParent !== null || el.classList.contains('form-section'));
    const widest = Math.max(0, ...[...output.querySelectorAll('table')].map(t =>
        [...(t.rows[0] || { cells: [] }).cells].filter(c => !c.classList.contains('no-print')).length));
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: widest > 7 ? 'landscape' : 'portrait', unit: 'mm', format: 'a4' });
    doc.setProperties({ title, creator: 'FEWA System' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 14;
    const usable = pageWidth - margin * 2;
    let y = margin;
    const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    const collegeName = pdfText((document.querySelector('#reportOutput .report-name') || {}).innerText || '');

    const room = needed => {
        if (y + needed > pageHeight - 16) {
            doc.addPage();
            y = margin;
        }
    };
    const dashed = () => {
        doc.setDrawColor(60, 60, 60);
        doc.setLineDashPattern([1, 1], 0);
        doc.setLineWidth(0.3);
        doc.line(margin, y, pageWidth - margin, y);
        doc.setLineDashPattern([], 0);
    };

    parts.forEach((part, partIndex) => {
        if (partIndex > 0) {
            doc.addPage();
            y = margin;
        }

        // Letterhead: logo on the left, the college's name, motto and contacts beside it, a line under
        const head = part.querySelector('.report-letterhead');
        if (head) {
            const logo = pdfImage(head.querySelector('img'));
            const logoHeight = 24;
            if (logo) doc.addImage(logo.data, 'JPEG', margin, y, Math.min(logoHeight * logo.ratio, 40), logoHeight);
            const textLeft = logo ? margin + Math.min(logoHeight * logo.ratio, 40) + 8 : margin;
            let ty = y + 7;
            doc.setFont('times', 'bold');
            doc.setFontSize(17);
            doc.setTextColor(...PDF_PURPLE);
            doc.text(pdfText((head.querySelector('.report-name') || {}).innerText), textLeft, ty);
            doc.setFont('times', 'italic');
            doc.setFontSize(10);
            doc.setTextColor(...PDF_GREY);
            // Contacts (P.O. Box, phone, email, website), then the TVETA and incorporation numbers
            doc.setFont('times', 'bold');
            doc.setTextColor(30, 30, 30);
            head.querySelectorAll('.report-contacts').forEach(line => {
                const lines = doc.splitTextToSize(pdfText(line.innerText), pageWidth - margin - textLeft);
                doc.text(lines, textLeft, ty += 6);
                ty += (lines.length - 1) * 4.5;
            });
            y += logoHeight + 4;
            doc.setDrawColor(...PDF_PURPLE);
            doc.setLineWidth(0.6);
            doc.line(margin, y, pageWidth - margin, y);
            doc.setDrawColor(...PDF_GOLD);
            doc.setLineWidth(0.4);
            doc.line(margin, y + 1, pageWidth - margin, y + 1);
            y += 9;
        }

        // Title on the left, today's date on the right
        const titleEl = part.querySelector('.report-title-line') || part.querySelector('.section-title');
        doc.setFont('times', 'bold');
        doc.setFontSize(18);
        doc.setTextColor(...PDF_TITLE);
        doc.text(pdfText(titleEl ? titleEl.innerText : title), margin, y);
        doc.setFont('times', 'normal');
        doc.setFontSize(11);
        doc.setTextColor(20, 20, 20);
        doc.text(today, pageWidth - margin, y, { align: 'right' });
        y += 7;
        doc.setFontSize(9.5);
        doc.setTextColor(...PDF_GREY);
        part.querySelectorAll('.report-heading .report-meta').forEach(meta => {
            if (/^Generated:/.test(meta.innerText.trim())) return;
            const lines = doc.splitTextToSize(pdfText(meta.innerText), usable);
            room(lines.length * 4.5);
            doc.text(lines, margin, y);
            y += lines.length * 4.5;
        });
        y += 3;

        // Then the report's blocks, in the order they are on the page
        const blocks = part.querySelectorAll('.report-header, .report-summary, .report-subtitle, .table-wrap > table, dl.detail-grid');
        blocks.forEach(block => {
            if (block.closest('.no-print')) return;

            if (block.classList.contains('report-header')) {
                // A student's name and details, with their photo on the right
                const photo = pdfImage(block.querySelector('img'));
                room(36);
                if (photo) doc.addImage(photo.data, 'JPEG', pageWidth - margin - 26, y, 26, 26 / photo.ratio > 34 ? 34 : 26 / photo.ratio);
                doc.setFont('times', 'bold');
                doc.setFontSize(14);
                doc.setTextColor(20, 20, 20);
                const name = block.querySelector('.report-name');
                if (name) doc.text(pdfText(name.innerText), margin, y + 6);
                doc.setFont('times', 'normal');
                doc.setFontSize(10);
                let ly = y + 12;
                block.querySelectorAll('.report-meta').forEach(meta => {
                    doc.text(doc.splitTextToSize(pdfText(meta.innerText), usable - 32), margin, ly);
                    ly += 5;
                });
                y = Math.max(ly, y + (photo ? 36 : 0)) + 2;
                return;
            }

            if (block.classList.contains('report-summary')) {
                // The total, then the summary boxes three to a row
                const total = block.querySelector('.report-total');
                if (total) {
                    room(10);
                    doc.setFont('times', 'bold');
                    doc.setFontSize(12);
                    doc.setTextColor(...PDF_PURPLE);
                    doc.text(`${pdfText(total.querySelector('.report-summary-title').innerText)}: ${pdfText(total.querySelector('.report-total-number').innerText)}`, margin, y + 4);
                    y += 9;
                }
                const boxes = [...block.querySelectorAll('.report-summary-box:not(.report-total)')];
                const gap = 6;
                const width = (usable - gap * 2) / 3;
                for (let i = 0; i < boxes.length; i += 3) {
                    const rowStart = y;
                    let rowEnd = y;
                    boxes.slice(i, i + 3).forEach((box, column) => {
                        doc.autoTable({
                            startY: rowStart,
                            margin: { left: margin + column * (width + gap) },
                            tableWidth: width,
                            theme: 'grid',
                            head: [[{ content: pdfText(box.querySelector('.report-summary-title').innerText), colSpan: 2 }]],
                            body: [...box.querySelectorAll('.dash-row')].map(row =>
                                [pdfText(row.children[0] && row.children[0].innerText), pdfText(row.children[1] && row.children[1].innerText)]),
                            styles: { font: 'times', fontSize: 9, cellPadding: 1.4, lineColor: [200, 200, 200], lineWidth: 0.2 },
                            headStyles: { fillColor: [244, 240, 248], textColor: PDF_PURPLE, fontStyle: 'bold' },
                            columnStyles: { 1: { halign: 'right', cellWidth: 16, fontStyle: 'bold' } }
                        });
                        rowEnd = Math.max(rowEnd, doc.lastAutoTable.finalY);
                        // A long box can move onto a new page: carry on below it there
                        if (doc.internal.getCurrentPageInfo().pageNumber !== doc.internal.getNumberOfPages()) doc.setPage(doc.internal.getNumberOfPages());
                    });
                    y = rowEnd + 5;
                }
                return;
            }

            if (block.classList.contains('report-subtitle')) {
                // A section heading in capitals with a dashed line under it
                room(16);
                y += 2;
                doc.setFont('times', 'bold');
                doc.setFontSize(11);
                doc.setTextColor(20, 20, 20);
                doc.text(pdfText(block.innerText).toUpperCase(), margin, y);
                y += 3;
                dashed();
                y += 2;
                return;
            }

            if (block.tagName === 'DL') {
                // Details as two label/value pairs per line
                const pairs = [...block.querySelectorAll(':scope > div')].map(d =>
                    [pdfText(d.querySelector('dt') && d.querySelector('dt').innerText), pdfText(d.querySelector('dd') && d.querySelector('dd').innerText)]);
                const body = [];
                for (let i = 0; i < pairs.length; i += 2) body.push([...pairs[i], ...(pairs[i + 1] || ['', ''])]);
                doc.autoTable({
                    startY: y, margin: { left: margin, right: margin }, theme: 'plain', body,
                    styles: { font: 'times', fontSize: 9.5, cellPadding: 1.2 },
                    columnStyles: { 0: { fontStyle: 'bold', cellWidth: usable * 0.2 }, 1: { cellWidth: usable * 0.3 },
                        2: { fontStyle: 'bold', cellWidth: usable * 0.2 }, 3: { cellWidth: usable * 0.3 } }
                });
                y = doc.lastAutoTable.finalY + 4;
                return;
            }

            // A table: plain, bold headings, no colours (as printed class lists); pictures stay in their cells
            const keep = cell => !cell.classList.contains('no-print');
            const headRow = block.tHead && block.tHead.rows[block.tHead.rows.length - 1];
            const head = headRow ? [[...headRow.cells].filter(keep).map(c => pdfText(c.innerText))] : [];
            const pictures = new Map();
            const body = [...(block.tBodies[0] || { rows: [] }).rows].map((row, r) => [...row.cells].filter(keep).map((c, ci) => {
                if (row.classList.contains('empty-row')) return { content: pdfText(c.innerText), colSpan: head[0] ? head[0].length : 1, styles: { halign: 'center', fontStyle: 'italic' } };
                const picture = pdfImage(c.querySelector('img'));
                if (picture) {
                    pictures.set(r + ':' + ci, picture);
                    return { content: '', styles: { minCellHeight: 16 } };
                }
                return pdfText(c.innerText);
            }));
            room(20);
            doc.autoTable({
                startY: y, margin: { left: margin, right: margin, bottom: 16 }, theme: 'plain', head, body,
                styles: { font: 'times', fontSize: 9.5, cellPadding: { top: 1.6, bottom: 1.6, left: 1.5, right: 1.5 }, textColor: [20, 20, 20], overflow: 'linebreak' },
                headStyles: { fontStyle: 'bold', fontSize: 10.5, textColor: [0, 0, 0] },
                didDrawCell: data => {
                    if (data.section === 'head' && data.column.index === 0) {
                        // A thin line under the headings
                        doc.setDrawColor(60, 60, 60);
                        doc.setLineWidth(0.2);
                        doc.line(margin, data.cell.y + data.cell.height, pageWidth - margin, data.cell.y + data.cell.height);
                    }
                    const picture = data.section === 'body' && pictures.get(data.row.index + ':' + data.column.index);
                    if (picture) {
                        const h = Math.min(data.cell.height - 2, 14);
                        doc.addImage(picture.data, 'JPEG', data.cell.x + 1, data.cell.y + 1, h * picture.ratio, h);
                    }
                }
            });
            y = doc.lastAutoTable.finalY + 6;
        });
    });

    // Page numbers and the college's name at the bottom of every page
    const pages = doc.internal.getNumberOfPages();
    for (let page = 1; page <= pages; page++) {
        doc.setPage(page);
        doc.setFont('times', 'normal');
        doc.setFontSize(8.5);
        doc.setTextColor(...PDF_GREY);
        doc.text(`Page ${page} of ${pages}`, pageWidth / 2, pageHeight - 8, { align: 'center' });
        if (collegeName) doc.text(collegeName, margin, pageHeight - 8);
        doc.text(`Printed ${new Date().toLocaleString()}`, pageWidth - margin, pageHeight - 8, { align: 'right' });
    }
    return doc;
}

// Makes the PDF of the report on the page and shows it in the viewer
async function showReportPdf(title) {
    if (!window.jspdf || !window.jspdf.jsPDF) {
        alert('The PDF maker could not be loaded. Refresh the page (Ctrl + F5) and try again.');
        return;
    }
    const doc = await buildReportPdf(title);
    if (pdfViewerUrl) URL.revokeObjectURL(pdfViewerUrl);
    pdfViewerUrl = URL.createObjectURL(doc.output('blob'));
    pdfViewerName = `${title} - ${new Date().toLocaleDateString('en-CA')}.pdf`.replace(/[\\/:*?"<>|]/g, '-');

    let viewer = document.getElementById('pdfViewer');
    if (!viewer) {
        viewer = document.createElement('div');
        viewer.id = 'pdfViewer';
        viewer.className = 'pdf-viewer no-print';
        viewer.innerHTML = `
            <div class="pdf-viewer-box" role="dialog" aria-modal="true" aria-labelledby="pdfViewerTitle">
                <div class="pdf-viewer-head">
                    <div id="pdfViewerTitle" class="pdf-viewer-title"></div>
                    <div class="pdf-viewer-buttons">
                        <button type="button" class="btn-submit" onclick="window.open(pdfViewerUrl, '_blank')">Open in new tab</button>
                        <button type="button" class="btn-secondary" onclick="downloadReportPdf()">Download</button>
                        <button type="button" class="btn-secondary" onclick="closeReportPdf()">&times; Close</button>
                    </div>
                </div>
                <iframe id="pdfViewerFrame" title="Report"></iframe>
            </div>`;
        viewer.addEventListener('click', event => { if (event.target === viewer) closeReportPdf(); });
        document.body.appendChild(viewer);
        document.addEventListener('keydown', event => { if (event.key === 'Escape' && !viewer.hidden) closeReportPdf(); });
    }
    document.getElementById('pdfViewerTitle').innerText = title;
    document.getElementById('pdfViewerFrame').src = pdfViewerUrl;
    viewer.hidden = false;
}

function downloadReportPdf() {
    if (!pdfViewerUrl) return;
    const link = document.createElement('a');
    link.href = pdfViewerUrl;
    link.download = pdfViewerName;
    link.click();
}

function closeReportPdf() {
    const viewer = document.getElementById('pdfViewer');
    if (viewer) viewer.hidden = true;
    const frame = document.getElementById('pdfViewerFrame');
    if (frame) frame.src = 'about:blank';
}
