const express = require('express');
const bcrypt = require('bcrypt');
const multer = require('multer');
const XLSX = require('xlsx');

const upload = multer({ storage: multer.memoryStorage() });

// HR routes module - exports a function that takes (pool, TABLE_NAME, authenticateHR, authenticateToken)
module.exports = (pool, TABLE_NAME, authenticateHR, authenticateToken) => {
  const router = express.Router();

  // ==================== HR FEEDBACK ROUTES ====================

  // GET /feedback/questions - get all active HR feedback questions with options
  router.get('/feedback/questions', async (req, res) => {
    try {
      // Fetch questions
      const [questions] = await pool.execute(
        'SELECT question_id, question_text, question_type FROM hr_feedback_questions WHERE is_active = 1 ORDER BY question_id'
      );
      if (!questions || questions.length === 0) {
        return res.json({ success: true, questions: [] });
      }

      // Fetch options for all these questions
      const questionIds = questions.map(q => q.question_id);
      const [options] = await pool.execute(
        `SELECT option_id, question_id, option_text, option_value
         FROM hr_feedback_options
         WHERE question_id IN (${questionIds.map(() => '?').join(',')})
         ORDER BY option_id`,
        questionIds
      );

      // Attach options to each question
      const questionsWithOptions = questions.map(q => ({
        ...q,
        options: options.filter(o => o.question_id === q.question_id)
      }));

      res.json({ success: true, questions: questionsWithOptions });
    } catch (err) {
      console.error('Error fetching HR questions', err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  // GET /feedback/responses - check if current HR user has submitted feedback
  router.get('/feedback/responses', async (req, res) => {
    try {
      const employeeId = req.employee.employeesID;
      const [rows] = await pool.execute(
        'SELECT COUNT(*) AS cnt FROM hr_feedback_responses WHERE employeesID = ?',
        [employeeId]
      );
      const hasSubmitted = rows[0]?.cnt > 0;
      return res.json({ success: true, hasSubmitted, count: rows[0]?.cnt || 0 });
    } catch (err) {
      console.error('Error checking HR responses', err);
      return res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  // POST /feedback/responses - submit HR feedback responses
  router.post('/feedback/responses', async (req, res) => {
    try {
      const employeeId = req.employee.employeesID;
      const { responses } = req.body || {};
      if (!Array.isArray(responses)) {
        return res.status(400).json({ success: false, message: 'Invalid payload, expected responses array' });
      }

      // Build batch insert
      const values = [];
      const placeholders = [];
      for (const resp of responses) {
        const { question_id, option_id, response_text } = resp;
        // option_id may be null
        placeholders.push('( ?, ?, ?, ? )');
        values.push(employeeId, question_id, option_id || null, response_text || null);
      }
      if (values.length === 0) {
        return res.status(400).json({ success: false, message: 'No responses to submit' });
      }

      const sql = `INSERT INTO hr_feedback_responses
        (employeesID, question_id, option_id, response_text)
        VALUES ${placeholders.join(',')}`;

      await pool.execute(sql, values);
      return res.json({ success: true, message: 'Feedback submitted' });
    } catch (err) {
      console.error('Error saving HR responses', err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  // ==================== EMPLOYEE MANAGEMENT ROUTES ====================

  // POST /import - CSV/XLSX import (HR only)
  router.post('/import', authenticateHR, upload.single('file'), async (req, res) => {
    try {
      const hrUser = req.employee;
      // minimal role check
      if (hrUser.role !== 'HR')
        return res.status(403).json({ message: 'Access denied' });
      if (!req.file)
        return res.status(400).json({ message: 'CSV file required' });
      
      // decode buffer with BOM-aware logic (handle UTF-8, UTF-16LE, UTF-16BE)
      const buf = req.file.buffer;
      let csv = '';
      let lines = [];
      const filename = (req.file.originalname || '').toLowerCase();
      
      // If XLS/XLSX, parse with xlsx library and convert into simple lines
      if (
        filename.endsWith('.xls') ||
        filename.endsWith('.xlsx') ||
        req.file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
        req.file.mimetype === 'application/vnd.ms-excel'
      ) {
        try {
          const workbook = XLSX.read(buf, { type: 'buffer' });
          // read first sheet
          const sheetName = workbook.SheetNames[0];
          const sheet = workbook.Sheets[sheetName];
          const json = XLSX.utils.sheet_to_json(sheet, {
            header: 1,
            raw: false,
          });
          // Each row in json is an array of cells; join by comma to mimic CSV row or if single-cell, push single value
          for (let r = 0; r < json.length; r++) {
            const row = json[r];
            if (!row || row.length === 0) continue;
            if (row.length === 1) lines.push(String(row[0]).trim());
            else
              lines.push(
                row.map((c) => (c == null ? '' : String(c))).join(',')
              );
          }
        } catch (xlsErr) {
          console.error(
            'Failed to parse xlsx file, falling back to text decode',
            xlsErr.message
          );
        }
      }
      
      // If not parsed from xlsx, fallback to BOM-aware text decode
      if (!lines.length) {
        if (
          buf.length >= 3 &&
          buf[0] === 0xef &&
          buf[1] === 0xbb &&
          buf[2] === 0xbf
        ) {
          csv = buf.toString('utf8');
        } else if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
          csv = buf.toString('utf16le');
        } else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
          // Node.js doesn't support utf16be directly; swap bytes to decode
          const swapped = Buffer.alloc(buf.length);
          for (let i = 0; i + 1 < buf.length; i += 2) {
            swapped[i] = buf[i + 1];
            swapped[i + 1] = buf[i];
          }
          csv = swapped.toString('utf16le');
        } else {
          csv = buf.toString('utf8');
        }
        const rawLines = csv.split(/\r?\n/); // keep empty lines for detection
        lines = rawLines.map((l) => l.trim()).filter(Boolean);
      }
      
      if (lines.length === 0)
        return res.status(400).json({ message: 'Empty CSV' });

      // Determine HR user's company_id once
      const [hrRow] = await pool.execute(
        `SELECT e.company_id, c.company_name FROM ${TABLE_NAME} e LEFT JOIN companies c ON e.company_id = c.company_id WHERE e.employeesID = ? LIMIT 1`,
        [hrUser.employeesID]
      );
      if (!hrRow || !hrRow.length)
        return res.status(400).json({ message: 'HR company not found' });
      const hrCompanyId = hrRow[0].company_id;

      // Determine employeesID column max length to pre-validate rows and avoid ER_DATA_TOO_LONG
      let employeesIDMax = null;
      try {
        const [colInfo] = await pool.execute(
          `SHOW COLUMNS FROM ${TABLE_NAME} LIKE 'employeesID'`
        );
        if (colInfo && colInfo.length) {
          const type = colInfo[0].Type; // e.g. varchar(50)
          const m = type.match(/varchar\((\d+)\)/i);
          if (m) employeesIDMax = parseInt(m[1], 10);
        }
      } catch (ciErr) {
        console.error(
          'Failed to fetch employeesID column info:',
          ciErr.message
        );
        employeesIDMax = null;
      }

      // assume simple rows: employeesID,name,email,role
      const results = { inserted: 0, skipped: 0, errors: [], generated: [] };

      // Delimiter detection: prefer comma, fallback to tab, else single-column lines (useful for .xl/.txt exports)
      let delimiter = null;
      const sampleForDelimiter =
        lines && lines.length ? String(lines[0]) : csv || '';
      if (sampleForDelimiter.indexOf(',') !== -1) delimiter = ',';
      else if (sampleForDelimiter.indexOf('\t') !== -1) delimiter = '\t';
      else delimiter = null; // single-column (each line is one field)

      // CSV/TSV parsing helper (handles quoted fields for comma delimited; simple split for others)
      function parseCsvRow(row, delim) {
        if (!delim) {
          // single-column mode: return the whole trimmed row as first field
          return [row.trim()];
        }
        if (delim === '\t') {
          // simple TSV split; trim fields and remove surrounding quotes if present
          return row.split('\t').map((p) => p.replace(/^\"|\"$/g, '').trim());
        }
        // comma-delimited with quotes support
        const parts = [];
        let cur = '';
        let inQuotes = false;
        for (let ci = 0; ci < row.length; ci++) {
          const ch = row[ci];
          if (ch === '"') {
            if (inQuotes && row[ci + 1] === '"') {
              cur += '"';
              ci++;
              continue;
            }
            inQuotes = !inQuotes;
            continue;
          }
          if (ch === ',' && !inQuotes) {
            parts.push(cur.trim());
            cur = '';
            continue;
          }
          cur += ch;
        }
        if (cur.length > 0) parts.push(cur.trim());
        for (let pi = 0; pi < parts.length; pi++) {
          parts[pi] = parts[pi].replace(/^\"|\"$/g, '').trim();
        }
        return parts;
      }

      // Detect header row and build a header map if present
      let startIndex = 0;
      let headerMap = null;
      const firstParts = parseCsvRow(lines[0], delimiter);
      const lowerFirst = firstParts.map((p) => (p || '').toLowerCase());
      const looksLikeHeader = lowerFirst.some(
        (p) =>
          p.includes('employeesid') ||
          p.includes('employees id') ||
          p === 'id' ||
          p.includes('email') ||
          p.includes('name') ||
          p.includes('role')
      );
      if (looksLikeHeader) {
        headerMap = {};
        for (let hi = 0; hi < lowerFirst.length; hi++) {
          const key = lowerFirst[hi].replace(/\s+/g, '');
          if (key.includes('employeesid') || key === 'id')
            headerMap.employeesID = hi;
          else if (key.includes('email')) headerMap.email = hi;
          else if (key.includes('name')) headerMap.name = hi;
          else if (key.includes('role')) headerMap.role = hi;
        }
        startIndex = 1;
      }

      for (let i = startIndex; i < lines.length; i++) {
        const row = lines[i];
        const parts = parseCsvRow(row, delimiter);
        if (parts.length < 1) {
          results.skipped++;
          results.errors.push({ line: i + 1, reason: 'Empty row' });
          continue;
        }

        // Map fields using headerMap when available; otherwise use heuristics for common orders
        let employeesID = '';
        let name = null;
        let email = null;
        let role = 'Employee';

        if (headerMap) {
          employeesID = parts[headerMap.employeesID] || '';
          name =
            headerMap.name != null
              ? parts[headerMap.name] || null
              : parts[1] || null;
          email =
            headerMap.email != null
              ? parts[headerMap.email] || null
              : parts[2] || null;
          role =
            headerMap.role != null
              ? parts[headerMap.role] || 'Employee'
              : parts[3] || 'Employee';
        } else {
          // No header: assume format employeesID, name, email, role (no password column expected)
          if (parts.length >= 4) {
            employeesID = parts[0] || '';
            name = parts[1] || null;
            email = parts[2] || null;
            role = parts[3] || 'Employee';
          } else if (parts.length === 3) {
            employeesID = parts[0] || '';
            name = parts[1] || null;
            email = parts[2] || null;
          } else if (parts.length === 2) {
            employeesID = parts[0] || '';
            name = parts[1] || null;
          } else {
            employeesID = parts[0] || '';
          }
        }

        if (!employeesID || employeesID.trim().length === 0) {
          results.skipped++;
          results.errors.push({ line: i + 1, reason: 'employeesID missing' });
          continue;
        }

        // Debug log parsed row
        console.log(
          `Import parse line ${i + 1}: employeesID='${employeesID}', name='${name}', email='${email}', role='${role}'`
        );

        try {
          // validate employeesID length if we know the column max
          if (
            employeesIDMax &&
            employeesID &&
            employeesID.length > employeesIDMax
          ) {
            results.skipped++;
            results.errors.push({
              line: i + 1,
              employeesID,
              reason: `employeesID too long (max ${employeesIDMax} chars)`,
            });
            continue;
          }
          // check existing by employeesID within company_id
          const [exists] = await pool.execute(
            `SELECT employeesID FROM ${TABLE_NAME} WHERE employeesID = ? AND company_id = ? LIMIT 1`,
            [employeesID, hrCompanyId]
          );
          if (exists && exists.length > 0) {
            results.skipped++;
            results.errors.push({
              line: i + 1,
              employeesID,
              reason: 'employeesID already exists in company',
            });
            continue;
          }

          // check email uniqueness within company_id
          if (email) {
            const [emailOwner] = await pool.execute(
              `SELECT employeesID FROM ${TABLE_NAME} WHERE email = ? AND company_id = ? LIMIT 1`,
              [email, hrCompanyId]
            );
            if (emailOwner && emailOwner.length > 0) {
              results.skipped++;
              results.errors.push({
                line: i + 1,
                employeesID,
                reason: `email ${email} already exists in company`,
              });
              continue;
            }
          }

          // Set static default password for all new employees
          let hashedPassword = null;
          try {
            const saltRounds = 10;
            const defaultPassword = 'Welcome@123'; // Static password for all employees
            hashedPassword = await bcrypt.hash(defaultPassword, saltRounds);
          } catch (hashErr) {
            console.error(
              'Password hash failed for',
              employeesID,
              hashErr && hashErr.message
            );
            results.skipped++;
            results.errors.push({
              line: i + 1,
              employeesID,
              reason: 'Password hashing failed',
            });
            continue;
          }

          // insert new employee with hashed password (or NULL) and is_loggedin set to FALSE
          await pool.execute(
            `INSERT INTO ${TABLE_NAME} (employeesID, password, name, email, role, company_id, is_loggedin) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [employeesID, hashedPassword, name, email, role, hrCompanyId, false]
          );
          results.inserted++;
        } catch (rowErr) {
          console.error('Import row error at line', i + 1, rowErr);
          results.skipped++;
          results.errors.push({
            line: i + 1,
            employeesID,
            reason: rowErr.message,
          });
          // continue with next row instead of aborting entire import
          continue;
        }
      }

      const delimLabel =
        delimiter === ','
          ? 'comma'
          : delimiter === '\t'
            ? 'tab'
            : 'single-line';
      res.json({
        message: `Import complete (${delimLabel} detected). Inserted ${results.inserted}, skipped ${results.skipped}`,
        results,
        detectedDelimiter: delimLabel,
      });
    } catch (error) {
      console.error('Import error:', error);
      res.status(500).json({ message: 'Import failed', error: error.message });
    }
  });

  // POST /employees - Add single employee (HR only), skip if existing
  router.post('/employees', authenticateHR, async (req, res) => {
    try {
      const hrUser = req.employee;
      if (hrUser.role !== 'HR')
        return res.status(403).json({ message: 'Access denied' });
      const { employeesID, name, email, role, company, company_id } = req.body;
      if (!employeesID)
        return res.status(400).json({ message: 'employeesID required' });

      // Determine target company_id: prefer provided company_id, otherwise use HR's company_id
      let targetCompanyId = company_id;
      if (!targetCompanyId) {
        const [hrRow] = await pool.execute(
          `SELECT e.company_id FROM ${TABLE_NAME} e WHERE e.employeesID = ? LIMIT 1`,
          [hrUser.employeesID]
        );
        if (!hrRow || !hrRow.length)
          return res.status(400).json({ message: 'HR company not found' });
        targetCompanyId = hrRow[0].company_id;
      }

      // check exists in same company
      const [exists] = await pool.execute(
        `SELECT employeesID FROM ${TABLE_NAME} WHERE employeesID = ? AND company_id = ? LIMIT 1`,
        [employeesID, targetCompanyId]
      );
      if (exists && exists.length > 0)
        return res.json({
          message: 'Employee already exists in company, skipped',
        });

      // Check email uniqueness within the target company (if email provided)
      if (email) {
        const [emailOwner] = await pool.execute(
          `SELECT e.employeesID, e.company_id, c.company_name FROM ${TABLE_NAME} e LEFT JOIN companies c ON e.company_id = c.company_id WHERE e.email = ? AND e.company_id = ? LIMIT 1`,
          [email, targetCompanyId]
        );
        if (emailOwner && emailOwner.length > 0) {
          return res
            .status(409)
            .json({
              message: `Email ${email} already used in company ${emailOwner[0].company_name || targetCompanyId} by employeesID ${emailOwner[0].employeesID}`,
            });
        }
      }

      // Set static default password for all new employees
      const saltRounds = 10;
      const defaultPassword = 'Welcome@123';
      const hashed = await bcrypt.hash(defaultPassword, saltRounds);

      await pool.execute(
        `INSERT INTO ${TABLE_NAME} (employeesID, password, name, email, role, company_id, is_loggedin) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          employeesID,
          hashed,
          name || null,
          email || null,
          role || 'Employee',
          targetCompanyId,
          false,
        ]
      );

      res.json({ message: 'Employee inserted' });
    } catch (error) {
      console.error('Add employee error:', error);
      // If duplicate key error on email, surface a clear message to HR with owner company
      if (
        error &&
        error.code === 'ER_DUP_ENTRY' &&
        (error.sqlMessage || '').includes('employees.email')
      ) {
        try {
          const [owner] = await pool.execute(
            `SELECT e.employeesID, c.company_name FROM ${TABLE_NAME} e LEFT JOIN companies c ON e.company_id = c.company_id WHERE e.email = ? LIMIT 1`,
            [email]
          );
          if (owner && owner.length) {
            return res.status(409).json({
              message: `Duplicate email: ${email} already exists`,
              detail: `This email is already used by employeesID '${owner[0].employeesID}' in company '${owner[0].company_name}'. If you want to allow the same email across different companies, update the database index to use a composite unique key on (email, company_id) instead of a unique constraint on email.`,
            });
          }
        } catch (qerr) {
          console.error('Error querying owner for duplicate email:', qerr);
        }
        return res
          .status(409)
          .json({ message: `Duplicate entry: ${error.sqlMessage}` });
      }

      res
        .status(500)
        .json({ message: 'Failed to add employee', error: error.message });
    }
  });

  return router;
};
