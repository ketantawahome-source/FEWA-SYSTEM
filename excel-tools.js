/* Excel tools shared by the upload screens (Staff > Import, Student Hub > Import Students, Manage Units, Exam Management)
   - FewaExcel.template(fileName, columns): a template whose required columns have a red heading with * and a light red
     column (the others a grey heading), with drop-down lists for the choices and a "How to fill it in" sheet.
   - FewaExcel.read(file): the rows of the first sheet (dates as Date objects, numbers as typed).
   - FewaExcel.feedback(fileName, headings, rows, results): after every upload, a copy of the uploaded rows with a
     Feedback column (green when the row went in, red with the reason when it did not), downloaded at once.
   - FewaExcel.check(rows, columns): every row checked against the columns (required, dates, phones, emails, lists).
   SheetJS cannot colour cells, so the files are written here part by part and zipped with SheetJS's own zip. */
(function () {
    let xlsxReady = null;

    // SheetJS is big, so it is loaded the first time a template is downloaded or a file uploaded
    function loadXlsx() {
        if (window.XLSX) return Promise.resolve(window.XLSX);
        xlsxReady = xlsxReady || new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'vendor/xlsx.full.min.js';
            script.onload = () => resolve(window.XLSX);
            script.onerror = () => { xlsxReady = null; reject(new Error('The Excel reader could not be loaded. Check the connection and try again.')); };
            document.head.append(script);
        });
        return xlsxReady;
    }

    const xml = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
    const letter = n => { let s = ''; for (n++; n; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; };
    const cellXml = (ref, text, style) => text === '' || text == null ? (style ? `<c r="${ref}" s="${style}"/>` : '')
        : `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t xml:space="preserve">${xml(text)}</t></is></c>`;

    // Styles (every one text format, so 0712..., long numbers and dates stay exactly as typed):
    // 1 red heading, 2 grey heading, 3 light red cell, 4 plain, 5 bold, 6 red bold, 7 green feedback, 8 red feedback, 9 dark heading
    const STYLE = { required: 1, optional: 2, requiredCell: 3, plain: 4, bold: 5, redBold: 6, ok: 7, bad: 8, dark: 9 };
    const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="5"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FF333333"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFC0392B"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FF1E5631"/><name val="Calibri"/></font></fonts>
<fills count="8"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFC0392B"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFD9D9D9"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFDE4E1"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFDFF2E3"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF9D6D2"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF24103A"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFBFBFBF"/></left><right style="thin"><color rgb="FFBFBFBF"/></right><top style="thin"><color rgb="FFBFBFBF"/></top><bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="10"><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="49" fontId="1" fillId="2" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="49" fontId="2" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="49" fontId="0" fillId="4" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="49" fontId="2" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="49" fontId="3" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="49" fontId="4" fillId="5" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
<xf numFmtId="49" fontId="3" fillId="6" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
<xf numFmtId="49" fontId="1" fillId="7" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

    /* Writes and downloads an .xlsx. sheets: [{ name, hidden, freeze, widths: [n], colStyles: [style], rows: [[text | { v, s }]],
       lists: [{ col, choices, open, rows }] }]. A sheet's drop-down choices go in a hidden "Lists" sheet. */
    async function writeWorkbook(fileName, sheets) {
        const XLSX = await loadXlsx();
        const allLists = [];
        const sheetXml = sheets.map(sheet => {
            const rows = sheet.rows.map((row, r) => `<row r="${r + 1}"${r === 0 && sheet.freeze ? ' ht="22" customHeight="1"' : ''}>${row.map((c, i) => {
                const cell = c && typeof c === 'object' && !(c instanceof Date) ? c : { v: c };
                return cellXml(letter(i) + (r + 1), cell.v instanceof Date ? dateText(cell.v) : cell.v, cell.s);
            }).join('')}</row>`).join('');
            const validations = (sheet.lists || []).filter(l => l.choices && l.choices.length).map(l => {
                allLists.push(l.choices);
                const col = letter(allLists.length - 1);
                return `<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="${l.open ? 0 : 1}" errorStyle="stop"` +
                    ` errorTitle="Not in the list" error="Pick one from the list." sqref="${letter(l.col)}2:${letter(l.col)}${l.rows || 1000}">` +
                    `<formula1>Lists!$${col}$1:$${col}$${l.choices.length}</formula1></dataValidation>`;
            });
            const widths = sheet.widths || [];
            const cols = widths.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"` +
                `${sheet.colStyles && sheet.colStyles[i] ? ` style="${sheet.colStyles[i]}"` : ''}/>`).join('')}</cols>` : '';
            return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0"${sheet === sheets[0] ? ' tabSelected="1"' : ''}>${sheet.freeze
                ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' : ''}</sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${rows}</sheetData>
${validations.length ? `<dataValidations count="${validations.length}">${validations.join('')}</dataValidations>` : ''}
<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;
        });
        const all = [...sheets.map((s, i) => ({ name: s.name, hidden: s.hidden, xml: sheetXml[i] }))];
        if (allLists.length) {
            const longest = Math.max(...allLists.map(l => l.length));
            all.push({ name: 'Lists', hidden: true, xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${Array.from({ length: longest }, (_, r) =>
                `<row r="${r + 1}">${allLists.map((l, c) => r < l.length ? cellXml(letter(c) + (r + 1), l[r]) : '').join('')}</row>`).join('')}</sheetData></worksheet>` });
        }
        const sheetName = name => xml(String(name).replace(/[\\\/?*\[\]:]/g, ' ').slice(0, 31));
        const files = {
            '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${all.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
            '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
            'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<bookViews><workbookView activeTab="0"/></bookViews><sheets>${all.map((s, i) =>
                `<sheet name="${sheetName(s.name)}" sheetId="${i + 1}"${s.hidden ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
            'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${all.map((s, i) =>
                `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}
<Relationship Id="rId${all.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
            'xl/styles.xml': STYLES
        };
        all.forEach((s, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = s.xml; });
        const zip = XLSX.CFB.utils.cfb_new({ root: 'R' });
        const utf8 = new TextEncoder();
        Object.entries(files).forEach(([path, text]) => XLSX.CFB.utils.cfb_add(zip, path, utf8.encode(text)));
        const data = XLSX.CFB.write(zip, { fileType: 'zip', type: 'array', compression: true });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
        link.download = fileName;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(link.href), 10000);
    }

    const pad = n => String(n).padStart(2, '0');
    function dateText(d) {
        const t = new Date(d.getTime() + 12 * 3600 * 1000);
        return `${pad(t.getDate())}/${pad(t.getMonth() + 1)}/${t.getFullYear()}`;
    }

    /* columns: [{ title, field, required, help, kind: 'text' | 'date' | 'phone' | 'email', choices, open }]
       choices: the drop-down list; open: other values may be typed too */
    function template(fileName, columns, sheetName = 'Data') {
        const help = [[{ v: 'Columns with a RED heading and * must be filled in on every row, or the file is NOT uploaded.', s: STYLE.redBold }],
            [{ v: 'Grey columns may be left empty. Dates as day/month/year, e.g. 15/04/1990.', s: STYLE.bold }], [],
            [{ v: 'Column', s: STYLE.bold }, { v: 'What to type', s: STYLE.bold }],
            ...columns.map(c => [{ v: c.required ? c.title + ' *' : c.title, s: c.required ? STYLE.redBold : 0 },
                c.help || (c.choices && !c.open ? 'Pick from the list' : c.required ? 'Required' : '')])];
        return writeWorkbook(fileName, [
            { name: sheetName, freeze: true, widths: columns.map(c => Math.max(15, c.title.length + 6)),
                colStyles: columns.map(c => c.required ? STYLE.requiredCell : STYLE.plain),
                rows: [columns.map(c => ({ v: c.required ? c.title + ' *' : c.title, s: c.required ? STYLE.required : STYLE.optional }))],
                lists: columns.map((c, col) => c.choices ? { col, choices: c.choices, open: c.open } : null).filter(Boolean) },
            { name: 'How to fill it in', widths: [28, 90], rows: help }
        ]);
    }

    // The uploaded rows again with a Feedback column: results[i] = { ok, text } for rows[i]
    function feedback(uploadedName, headings, rows, results) {
        const base = String(uploadedName || 'upload').replace(/\.[^.]+$/, '');
        const okCount = results.filter(r => r && r.ok).length;
        const width = Math.max(headings.length, ...rows.map(r => r.length));
        const head = Array.from({ length: width }, (_, i) => ({ v: headings[i] ?? '', s: STYLE.dark }));
        return writeWorkbook(`${base} - feedback.xlsx`, [{
            name: 'Feedback', freeze: true,
            widths: [...Array.from({ length: width }, (_, i) => Math.min(40, Math.max(12, String(headings[i] ?? '').length + 4))), 70],
            rows: [[...head, { v: `Feedback (${okCount} of ${rows.length} in)`, s: STYLE.dark }],
                ...rows.map((r, i) => {
                    const result = results[i] || { ok: false, text: 'Not checked' };
                    return [...Array.from({ length: width }, (_, c) => r[c] ?? ''), { v: result.text, s: result.ok ? STYLE.ok : STYLE.bad }];
                })]
        }]).catch(() => {});
    }

    // The first sheet's rows (heading row included); empty rows at the end are dropped
    async function read(file) {
        const XLSX = await loadXlsx();
        const book = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
        const rows = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1, defval: '', raw: true });
        return rows.map(r => r.map(c => c instanceof Date ? c : String(c ?? '').trim()));
    }

    // ----- checking the cells -----
    const phone = value => {
        const text = String(value).replace(/\.0+$/, '').replace(/[\s-]/g, '');
        const match = (/^[17]\d{8}$/.test(text) ? '0' + text : text).match(/^(?:\+?254|0)([17]\d{8})$/);
        return match ? '+254' + match[1] : '';
    };
    const email = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value).trim()) ? String(value).trim().toLowerCase() : '';
    const choice = (value, choices) => (choices || []).find(c => c.toLowerCase() === String(value).trim().toLowerCase()) || '';
    // A date cell, or typed as 15/04/1990, 15-04-1990 or 1990-04-15: yyyy-mm-dd, or '' when it is not a date
    function date(value) {
        let y, m, d;
        if (value instanceof Date) {
            const t = new Date(value.getTime() + 12 * 3600 * 1000);
            [y, m, d] = [t.getFullYear(), t.getMonth() + 1, t.getDate()];
        } else {
            const text = String(value).trim();
            let match = text.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
            if (match) [d, m, y] = [+match[1], +match[2], +match[3]];
            else if ((match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) [y, m, d] = [+match[1], +match[2], +match[3]];
            else return '';
        }
        const when = new Date(Date.UTC(y, m - 1, d));
        if (when.getUTCFullYear() !== y || when.getUTCMonth() !== m - 1 || when.getUTCDate() !== d || y < 1900 || y > 2100) return '';
        return when.toISOString().slice(0, 10);
    }
    const shown = value => value instanceof Date ? dateText(value) : String(value);

    /* Finds the columns by their heading (any order, with or without the *) and checks every row.
       Returns { missingColumns, people: [{ line, values, problems: [] }] } (values converted: dates yyyy-mm-dd,
       phones +254..., emails in small letters, choices as spelt in the list) */
    function check(rows, columns) {
        const headings = (rows[0] || []).map(h => String(h).replace(/\*/g, '').trim().toLowerCase());
        const where = Object.fromEntries(columns.map(c => [c.field, headings.indexOf(c.title.toLowerCase())]));
        const missingColumns = columns.filter(c => c.required && where[c.field] < 0).map(c => c.title);
        const people = [];
        rows.slice(1).forEach((r, i) => {
            if (!r.some(c => shown(c).trim() !== '')) return;
            const values = {}, problems = [];
            for (const c of columns) {
                const raw = where[c.field] < 0 ? '' : r[where[c.field]];
                const text = shown(raw ?? '').trim();
                if (text === '') { values[c.field] = ''; if (c.required) problems.push(`${c.title} is empty`); continue; }
                if (c.kind === 'date') { values[c.field] = date(raw); if (!values[c.field]) problems.push(`${c.title} "${text}" is not a date (type it as day/month/year)`); }
                else if (c.kind === 'phone') { values[c.field] = phone(text); if (!values[c.field]) problems.push(`${c.title} ${text} is not a Kenyan mobile number`); }
                else if (c.kind === 'email') { values[c.field] = email(text); if (!values[c.field]) problems.push(`${c.title} ${text} is not a valid email`); }
                else if (c.choices && !c.open) {
                    values[c.field] = choice(text, c.choices);
                    if (!values[c.field]) problems.push(!c.choices.length ? `${c.title} "${text}": none is set up yet in Settings`
                        : `${c.title} "${text}" is not one of: ${c.choices.length > 12 ? c.choices.slice(0, 12).join(', ') + '...' : c.choices.join(', ')}`);
                }
                else values[c.field] = (c.choices && choice(text, c.choices)) || text;
            }
            people.push({ line: i + 2, index: i, values, problems });
        });
        return { missingColumns, people };
    }

    window.FewaExcel = { loadXlsx, template, feedback, read, check, date, phone, email, choice, shown, writeWorkbook };
})();
