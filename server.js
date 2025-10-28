const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const axios = require("axios");
const XLSX = require("xlsx");
require("dotenv").config();

// Import middleware
const authenticateAdmin = require("./middlewares/admin.auth");
const { authenticateEmployee } = require("./middlewares/employee.auth");
const authenticateHR = require("./middlewares/hr.auth");

// Make sure we're exporting the middleware correctly (not as an object)
const authenticateToken = (req, res, next) => {
  const token = req.headers["authorization"]?.split(" ")[1];
  if (!token) return res.status(401).json({ message: "Access token required" });

  jwt.verify(
    token,
    process.env.JWT_SECRET || "your-secret-key",
    (err, employee) => {
      if (err)
        return res.status(403).json({ message: "Invalid or expired token" });
      req.employee = employee;
      next();
    }
  );
};

const app = express();
const PORT = process.env.PORT || 3002;

// Middleware
app.use(cors());
app.use(express.json());

// MySQL connection configuration
const dbConfig = {
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "fortai_employees",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
};

const TABLE_NAME = "employees"; // unified table name

// Flask configuration from environment
const FLASK_HOST = process.env.FLASK_HOST || "localhost";
const FLASK_PORT = process.env.FLASK_PORT || "5000";
console.log("🔧 Debug - FLASK_HOST:", FLASK_HOST, "FLASK_PORT:", FLASK_PORT);
// Remove any http:// prefix from FLASK_HOST if present to avoid double protocol
const cleanHost = FLASK_HOST.replace(/^https?:\/\//, '');
console.log("🔧 Debug - cleanHost:", cleanHost);
// Check if port is already included in the host (e.g., "localhost:5000")
const FLASK_BASE_URL = cleanHost.includes(':')
  ? `http://${cleanHost}`
  : `http://${cleanHost}:${FLASK_PORT}`;
console.log("🔧 Debug - Final FLASK_BASE_URL:", FLASK_BASE_URL);
const FLASK_TIMEOUT = parseInt(process.env.FLASK_TIMEOUT) || 180000; // 3 minutes for AI processing

// Create connection pool
const pool = mysql.createPool(dbConfig);

// Test database connection
async function testConnection() {
  try {
    const connection = await pool.getConnection();
    console.log("✅ Connected to MySQL database");
    connection.release();
  } catch (error) {
    console.error("❌ Database connection failed:", error.message);
    console.log(
      "Please make sure MySQL is running and credentials are correct"
    );
  }
}

testConnection();

// Import and use login routes - make sure we're only passing the pool
const loginRoutes = require('./routes/login.route')(pool);
app.use('/api', loginRoutes);

// Remove the static routes since we're now serving dynamic HTML from the routes
// app.use('/api/reset-password-page', express.static('public/reset-password.html'));
// app.use('/api/set-password-page', express.static('public/set-password.html'));
// app.use('/api/request-reset-page', express.static('public/request-reset.html'));

// Make authenticateToken available to routes
app.use((req, res, next) => {
  req.authenticateToken = authenticateToken;
  next();
});

// Generic change password route (for all authenticated users)
app.post('/api/change-password', authenticateToken, async (req, res) => {
  try {
    const { current, newPassword } = req.body;
    const emp = req.employee;
    if (!newPassword)
      return res.status(400).json({ message: 'newPassword required' });

    // fetch existing hashed password (if any)
    const [rows] = await pool.execute(
      `SELECT password FROM ${TABLE_NAME} WHERE employeesID = ?`,
      [emp.employeesID]
    );
    if (!rows.length)
      return res.status(404).json({ message: 'Employee not found' });

    const existingHash = rows[0].password;
    // if existing password exists, verify current
    if (existingHash) {
      let ok = false;
      try {
        // If stored value looks like a bcrypt hash, use bcrypt.compare
        if (
          typeof existingHash === 'string' &&
          existingHash.startsWith('$2')
        ) {
          ok = await bcrypt.compare(current || '', existingHash);
        } else {
          // Legacy plaintext password in DB: compare directly
          ok = current === existingHash;
        }
      } catch (pwErr) {
        console.error(
          'Password verification error for change-password',
          req.employee?.employeesID,
          pwErr
        );
        return res
          .status(500)
          .json({ message: 'Server error during password verification' });
      }
      if (!ok)
        return res
          .status(401)
          .json({ message: 'Current password incorrect' });
    }

    const saltRounds = 10;
    const hashed = await bcrypt.hash(newPassword, saltRounds);

    // Update password and mark as logged in (for first-time login scenario)
    await pool.execute(
      `UPDATE ${TABLE_NAME} SET password = ?, is_loggedin = TRUE WHERE employeesID = ?`,
      [hashed, emp.employeesID]
    );

    res.json({ message: 'Password updated successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    res
      .status(500)
      .json({ message: 'Failed to change password', error: error.message });
  }
});

// HR routes (employees management, HR feedback)
const hrRoutes = require('./routes/hr.route')(pool, TABLE_NAME, authenticateHR, authenticateToken);
app.use('/api/hr', authenticateHR, hrRoutes);

// Admin routes
const adminRoutes = require('./routes/admin.route')(pool);
app.use('/api/admin', authenticateAdmin, adminRoutes);

// Admin: Company report status (counts by is_filled)
app.get('/api/admin/company/:company/report/status', authenticateAdmin, async (req, res) => {
  try {
    const companyParam = req.params.company;
    let companyId = Number(companyParam);
    if (Number.isNaN(companyId)) {
      const [rows] = await pool.execute(
        'SELECT company_id FROM companies WHERE company_name = ? LIMIT 1',
        [companyParam]
      );
      if (!rows.length) return res.status(404).json({ success: false, message: 'Company not found' });
      companyId = rows[0].company_id;
    }
    const [rows] = await pool.execute(
      `SELECT COALESCE(is_filled,0) AS is_filled FROM ${TABLE_NAME} WHERE company_id = ? AND role != 'HR'`,
      [companyId]
    );
    const total = rows.length;
    const filled = rows.filter(r => r.is_filled).length;
    return res.json({ success: true, total, filled });
  } catch (err) {
    console.error('Admin report status error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Admin: Company report fetch
app.get('/api/admin/company/:company/report', authenticateAdmin, async (req, res) => {
  try {
    const companyParam = req.params.company;
    let companyId = Number(companyParam);
    if (Number.isNaN(companyId)) {
      const [rows] = await pool.execute(
        'SELECT company_id FROM companies WHERE company_name = ? LIMIT 1',
        [companyParam]
      );
      if (!rows.length) return res.status(404).json({ success: false, message: 'Company not found' });
      companyId = rows[0].company_id;
    }
    // ensure all non-HR employees have filled
    const [rows] = await pool.execute(
      `SELECT COALESCE(is_filled,0) AS is_filled FROM ${TABLE_NAME} WHERE company_id = ? AND role != 'HR'`,
      [companyId]
    );
    const total = rows.length;
    const filled = rows.filter(r => r.is_filled).length;
    if (filled !== total) return res.status(409).json({ success: false, message: 'Not ready' });
    const [reportRows] = await pool.execute(
      'SELECT * FROM company_reports_sentiment WHERE company_id = ? ORDER BY created_at DESC LIMIT 1',
      [companyId]
    );
    if (!reportRows.length) return res.status(404).json({ success: false, message: 'No report' });
    return res.json({ success: true, report: reportRows[0] });
  } catch (err) {
    console.error('Admin report fetch error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Admin: list distinct companies in the system (companies table)
app.get('/api/admin/companies', authenticateAdmin, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT c.company_id, c.company_name, COUNT(e.employeesID) AS count
       FROM companies c
       LEFT JOIN ${TABLE_NAME} e ON e.company_id = c.company_id
       GROUP BY c.company_id, c.company_name
       ORDER BY c.company_name`
    );

    const companies = (rows || []).map(r => ({
      companyId: r.company_id,
      companyName: r.company_name,
      company: r.company_name, // backward compat key
      count: r.count
    }));
    res.json({ success: true, companies });
  } catch (error) {
    console.error('Error fetching companies:', error && error.message ? error.message : error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Admin: list employees for a specific company (by id or name; all roles included)
app.get('/api/admin/company/:company/employees', authenticateAdmin, async (req, res) => {
  try {
    const companyParam = req.params.company;
    if (!companyParam) return res.status(400).json({ success: false, message: 'Company required' });

    // Resolve company id: if numeric use directly, else lookup by company_name
    let companyId = Number(companyParam);
    if (Number.isNaN(companyId)) {
      const [rowsId] = await pool.execute(
        'SELECT company_id FROM companies WHERE company_name = ? LIMIT 1',
        [companyParam]
      );
      if (!rowsId || !rowsId.length) return res.status(404).json({ success: false, message: 'Company not found' });
      companyId = rowsId[0].company_id;
    }

    const [rows] = await pool.execute(
      `SELECT e.employeesID, e.name, e.email, e.role, c.company_name AS company
       FROM ${TABLE_NAME} e
       LEFT JOIN companies c ON e.company_id = c.company_id
       WHERE e.company_id = ?
       ORDER BY e.role, e.name`,
      [companyId]
    );

    res.json({ success: true, employees: rows || [], count: (rows || []).length });
  } catch (error) {
    console.error('Error fetching employees for company:', error && error.message ? error.message : error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Admin: create a new company (companies.company_name)
app.post('/api/admin/companies', authenticateAdmin, async (req, res) => {
  try {
    const { company } = req.body || {};
    if (!company || String(company).trim() === '') return res.status(400).json({ success: false, message: 'Company name required' });

    // Insert into companies table
    await pool.execute('INSERT INTO companies (company_name) VALUES (?)', [company]);

    return res.json({ success: true, message: 'Company created' })
  } catch (error) {
    console.error('Error creating company:', error && error.message ? error.message : error)
    return res.status(500).json({ success: false, message: 'Server error' })
  }
});

// Admin: add an HR employee under a specific company (param can be id or name)
app.post('/api/admin/company/:company/hr', authenticateAdmin, async (req, res) => {
  try {
    const companyParam = req.params.company
    const { employeesID, password, name, email, role } = req.body || {}
    if (!employeesID) return res.status(400).json({ success: false, message: 'employeesID required' })
    // default role to HR and company to param
    const finalRole = role || 'HR'
    // resolve company_id
    let companyId = Number(companyParam);
    if (Number.isNaN(companyId)) {
      const [rowsId] = await pool.execute('SELECT company_id FROM companies WHERE company_name = ? LIMIT 1', [companyParam]);
      if (!rowsId || !rowsId.length) return res.status(404).json({ success: false, message: 'Company not found' });
      companyId = rowsId[0].company_id;
    }

    // insert into employees table
    try {
      await pool.execute(
        `INSERT INTO ${TABLE_NAME} (employeesID, password, name, email, role, company_id) VALUES (?, ?, ?, ?, ?, ?)`,
        [employeesID, password || null, name || null, email || null, finalRole, companyId]
      )
      return res.json({ success: true, message: 'HR added' })
    } catch (dbErr) {
      console.error('DB error adding HR:', dbErr && dbErr.message ? dbErr.message : dbErr)
      return res.status(500).json({ success: false, message: 'Database error: ' + (dbErr.message || dbErr) })
    }
  } catch (error) {
    console.error('Error in add HR endpoint:', error && error.message ? error.message : error)
    return res.status(500).json({ success: false, message: 'Server error' })
  }
})

// HR: reset sentiment responses so employee can retake the survey
app.delete('/api/hr/employee/:employeesID/responses', authenticateHR, async (req, res) => {
  try {
    const employeesID = req.params.employeesID;
    if (!employeesID) return res.status(400).json({ success: false, message: 'employeesID required' });
    // Delete all sentiment form responses
    const [respCount] = await pool.execute(
      'DELETE FROM Responses_Sentiment WHERE employeesID = ?',
      [employeesID]
    );
    // Delete any generated Langchain reports (Attrition strategies)
    const [reportCount] = await pool.execute(
      'DELETE FROM responses_langchain_sentiment WHERE employeesID = ?',
      [employeesID]
    );
    // Reset the is_filled flag so the survey can be taken again
    await pool.execute(
      `UPDATE ${TABLE_NAME} SET is_filled = 0 WHERE employeesID = ?`,
      [employeesID]
    );
    // Clear any existing company-level report since one employee must re-submit
    // Determine company_id for this employee
    const [[empRow]] = await pool.execute(
      `SELECT company_id FROM ${TABLE_NAME} WHERE employeesID = ? LIMIT 1`,
      [employeesID]
    );
    if (empRow && empRow.company_id) {
      await pool.execute(
        'DELETE FROM company_reports_sentiment WHERE company_id = ?',
        [empRow.company_id]
      );
    }
    return res.json({
      success: true,
      message: `Cleared ${respCount.affectedRows} form responses` +
        (reportCount.affectedRows ? ` and ${reportCount.affectedRows} generated report(s)` : '')
    });
  } catch (error) {
    console.error('Error resetting responses:', error && error.message ? error.message : error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Feedback endpoint: HR and Manager can submit feedback about experience
app.post('/api/feedback', authenticateToken, async (req, res) => {
  try {
    const employee = req.employee;
    if (!['HR', 'Manager'].includes(employee.role)) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    const { satisfactionPercent, payWillingness } = req.body || {};
    if (typeof satisfactionPercent !== 'number' || typeof payWillingness !== 'number') {
      return res.status(400).json({ success: false, message: 'Invalid feedback data' });
    }
    // Optionally, store in a new 'feedback' table if exists
    try {
      await pool.execute(
        `INSERT INTO feedback (employeesID, role, satisfaction_percent, pay_per_employee, created_at)
         VALUES (?, ?, ?, ?, NOW())`,
        [employee.employeesID, employee.role, satisfactionPercent, payWillingness]
      );
    } catch (err) {
      console.warn('Feedback table insertion failed (table may not exist):', err.message);
      // continue silently
    }
    res.json({ success: true, message: 'Feedback submitted' });
  } catch (error) {
    console.error('Error in feedback endpoint:', error && error.message ? error.message : error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// --- Sentiment APIs ---
// Test database connection and tables
app.get("/api/sentiment/test", authenticateEmployee, async (req, res) => {
  try {
    // Test basic connection
    await pool.execute("SELECT 1");

    // Check if tables exist
    const [forms] = await pool.execute(
      "SELECT COUNT(*) as count FROM Forms_Sentiment"
    );
    const [master] = await pool.execute(
      "SELECT COUNT(*) as count FROM MasterQuestions_Sentiment"
    );
    const [formQuestions] = await pool.execute(
      "SELECT COUNT(*) as count FROM FormQuestions_Sentiment"
    );

    res.json({
      success: true,
      database: "connected",
      tables: {
        forms: forms[0].count,
        masterQuestions: master[0].count,
        formQuestions: formQuestions[0].count,
      },
    });
  } catch (error) {
    console.error("Database test error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get questions for a form_id
app.get("/api/sentiment/form/:form_id", authenticateEmployee, async (req, res) => {
  const { form_id } = req.params;
  console.log("Fetching sentiment form for form_id:", form_id); // Debug log

  try {
    const [rows] = await pool.execute(
      `SELECT fq.form_question_id, f.form_name, mq.question_number, mq.question_type, mq.options_questions, mq.helper_text, fq.question_text
       FROM FormQuestions_Sentiment fq
       JOIN Forms_Sentiment f ON fq.form_id = f.form_id
       JOIN MasterQuestions_Sentiment mq ON fq.master_question_id = mq.master_question_id
       WHERE fq.form_id = ?
       ORDER BY mq.question_number`,
      [form_id]
    );

    console.log("Query result rows:", rows.length); // Debug log
    res.json({ success: true, questions: rows });
  } catch (error) {
    console.error("Error fetching sentiment form:", error.message);
    console.error("Full error:", error); // More detailed error log
    res
      .status(500)
      .json({ success: false, message: "Server error: " + error.message });
  }
});

// Post responses - ENHANCED to trigger AI analysis
app.post("/api/sentiment/response", authenticateEmployee, async (req, res) => {
  try {
    // Accept either a numeric employee_id or an employeesID string (employeeId)
    const { employee_id, employeeId, form_id, formId, answers } = req.body;
    const resolvedFormId = form_id || formId;
    const resolvedEmployee = employee_id || employeeId;

    if (!resolvedEmployee || !resolvedFormId || !Array.isArray(answers)) {
      return res.status(400).json({
        success: false,
        message: "employee identifier, form_id and answers[] required",
      });
    }

    // Only use employeesID column for inserts
    const [colPlain] = await pool.execute(
      `SHOW COLUMNS FROM Responses_Sentiment LIKE 'employeesID'`
    );
    const hasPlainEmployeesID = colPlain && colPlain.length > 0;
    if (!hasPlainEmployeesID) {
      console.error("Responses_Sentiment table missing employeesID column");
      return res.status(500).json({
        success: false,
        message: "Database schema missing employeesID column",
      });
    }

    // Log resolved employee and column availability for debugging
    console.log(
      "Resolved employee:",
      resolvedEmployee,
      "hasPlainEmployeesID:",
      hasPlainEmployeesID
    );

    // First, save the responses to Responses_Sentiment table
    const insertPromises = answers.map((a) => {
      console.log("Inserting into Responses_Sentiment (employeesID) params:", [
        resolvedEmployee,
        resolvedFormId,
        a.form_question_id,
        a.answer_text || null,
        a.answer_choice || null,
      ]);
      return pool.execute(
        `INSERT INTO Responses_Sentiment (employeesID, form_id, form_question_id, answer_text, answer_choice) VALUES (?, ?, ?, ?, ?)`,
        [
          resolvedEmployee,
          resolvedFormId,
          a.form_question_id,
          a.answer_text || null,
          a.answer_choice || null,
        ]
      );
    });

    // Execute inserts sequentially so we can capture and log which row fails
    for (let i = 0; i < insertPromises.length; i++) {
      try {
        await insertPromises[i];
      } catch (rowErr) {
        console.error(
          "Failed inserting response row",
          i,
          "error:",
          rowErr.message
        );
        return res.status(500).json({
          success: false,
          message: `Failed to save response row ${i}: ${rowErr.message}`,
        });
      }
    }

    // Mark employee as filled (submitted the form)
    try {
      await pool.execute(
        `UPDATE ${TABLE_NAME} SET is_filled = 1 WHERE employeesID = ?`,
        [resolvedEmployee]
      );
      console.log("✅ Marked employee as filled:", resolvedEmployee);
    } catch (ufErr) {
      console.error("⚠️ Failed to update is_filled for", resolvedEmployee, ufErr.message);
      // continue — responses are saved; we won't fail the whole request
    }

    console.log(
      "✅ Responses saved successfully."
    );

    // NEW: Check if all employees in the company have filled their surveys
    // If yes, automatically trigger company-wide analysis
    try {
      // Get the employee's company_id
      const [empCompany] = await pool.execute(
        `SELECT company_id FROM ${TABLE_NAME} WHERE employeesID = ? LIMIT 1`,
        [resolvedEmployee]
      );

      if (empCompany && empCompany.length > 0) {
        const companyId = empCompany[0].company_id;

        // Check if all non-HR employees in the company have filled their surveys
        const [companyEmployees] = await pool.execute(
          `SELECT COALESCE(is_filled, 0) AS is_filled FROM ${TABLE_NAME} WHERE company_id = ? AND role != 'HR'`,
          [companyId]
        );

        const totalEmployees = (companyEmployees || []).length;
        const filledEmployees = (companyEmployees || []).filter(e => !!e.is_filled).length;

        console.log(`📊 Company ${companyId} survey status: ${filledEmployees}/${totalEmployees} employees completed`);

        // If ALL employees have completed their surveys, trigger company analysis
        if (totalEmployees > 0 && filledEmployees === totalEmployees) {
          console.log(`🎯 All employees in company ${companyId} have completed surveys! Triggering automatic company analysis...`);

          // Trigger company analysis asynchronously (don't wait for it to complete)
          triggerCompanyAnalysis(companyId).then(() => {
            console.log(`✅ Automatic company analysis completed for company ${companyId}`);
          }).catch((err) => {
            console.error(`⚠️ Automatic company analysis failed for company ${companyId}:`, err.message);
            // Don't fail the employee response submission even if company analysis fails
          });
        }
      }
    } catch (autoAnalysisErr) {
      console.error("⚠️ Error checking for automatic company analysis:", autoAnalysisErr.message);
      // Don't fail the employee response submission even if this check fails
    }

    res.json({
      success: true,
      message: "Responses saved successfully",
    });
  } catch (error) {
    console.error("Error saving responses:", error.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// NEW: Function to trigger company-wide AI analysis
async function triggerCompanyAnalysis(companyId) {
  try {
    console.log("🤖 Starting automatic company analysis for company:", companyId);

    // STEP 1: First, generate individual employee reports for all employees in the company
    console.log("📝 Step 1: Generating individual employee reports for all employees...");

    // Get all employees in the company who have filled the survey
    const [employees] = await pool.execute(
      `SELECT employeesID FROM ${TABLE_NAME} WHERE company_id = ? AND role != 'HR' AND COALESCE(is_filled, 0) = 1`,
      [companyId]
    );

    console.log(`Found ${employees.length} employees to analyze individually`);

    // Generate individual reports for each employee
    for (const emp of employees) {
      const employeeId = emp.employeesID;

      try {
        console.log(`  ➡️ Generating individual report for employee ${employeeId}...`);

        // Get employee's company name
        const [empInfo] = await pool.execute(
          `SELECT c.company_name FROM ${TABLE_NAME} e
           LEFT JOIN companies c ON e.company_id = c.company_id
           WHERE e.employeesID = ? LIMIT 1`,
          [employeeId]
        );

        const companyName = empInfo && empInfo[0] ? empInfo[0].company_name : null;

        // Fetch employee's survey responses
        const [responses] = await pool.execute(
          `SELECT
            rs.form_question_id,
            rs.answer_text,
            rs.answer_choice,
            mq.question_number,
            fq.question_text
          FROM Responses_Sentiment rs
          JOIN FormQuestions_Sentiment fq ON rs.form_question_id = fq.form_question_id
          JOIN MasterQuestions_Sentiment mq ON fq.master_question_id = mq.master_question_id
          WHERE rs.employeesID = ?
          ORDER BY mq.question_number`,
          [employeeId]
        );

        if (responses && responses.length > 0) {
          // Format responses for AI analysis
          const formattedAnswers = {};
          responses.forEach((response) => {
            const qNum = response.question_number;
            const answer = response.answer_text || response.answer_choice || "";
            formattedAnswers[`q${qNum}`] = {
              question: response.question_text,
              answer: answer
            };
          });

          // Call Flask AI endpoint for individual employee analysis
          const individualPayload = {
            employeeId: employeeId,
            company: companyName,  // ✅ Added missing company parameter
            answers: formattedAnswers
          };

          const individualResponse = await axios.post(
            `${FLASK_BASE_URL}/analyze`,
            individualPayload,
            {
              timeout: FLASK_TIMEOUT,
              headers: {
                'Content-Type': 'application/json'
              }
            }
          );

          console.log(`  ✅ Individual report generated for employee ${employeeId}`);
        } else {
          console.warn(`  ⚠️ No responses found for employee ${employeeId}`);
        }
      } catch (empErr) {
        console.error(`  ❌ Failed to generate report for employee ${employeeId}:`, empErr.message);
        // Continue with other employees even if one fails
      }
    }

    console.log("✅ Step 1 Complete: All individual employee reports generated");

    // STEP 2: Now generate the company-wide analysis
    console.log("📊 Step 2: Generating company-wide analysis report...");

    const payload = {
      companyId: companyId
    };

    console.log("➡️ Sending company analysis request to Flask:", `${FLASK_BASE_URL}/analyze-company`);

    const response = await axios.post(
      `${FLASK_BASE_URL}/analyze-company`,
      payload,
      {
        timeout: FLASK_TIMEOUT,
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    console.log("✅ Step 2 Complete: Company analysis report generated and saved");
    console.log("🎉 Full automatic analysis completed successfully!");
    return response.data;

  } catch (error) {
    console.error("❌ Company analysis error:", error.message);
    if (error.response) {
      console.error("Flask error response:", error.response.data);
    }
    throw error;
  }
}

// Get all employees in the same company as HR user (except HR themselves)
app.get("/api/reports/employees", authenticateHR, async (req, res) => {
  try {
    const hrUser = req.employee;

    // First get the HR user's company_id and name
    const [hrResult] = await pool.execute(
      `SELECT e.company_id, c.company_name
       FROM ${TABLE_NAME} e
       LEFT JOIN companies c ON e.company_id = c.company_id
       WHERE e.employeesID = ?
       LIMIT 1`,
      [hrUser.employeesID]
    );

    if (!hrResult.length) {
      return res.status(404).json({ error: "HR user not found" });
    }

    const companyId = hrResult[0].company_id;
    const company = hrResult[0].company_name || null;

    // Get all employees in the same company (except HR), include is_filled flag
    const [employees] = await pool.execute(
      `SELECT employeesID, name, email, role, COALESCE(is_filled, 0) AS is_filled FROM ${TABLE_NAME} WHERE company_id = ? AND role != 'HR'`,
      [companyId]
    );

    // For each employee, check if they have filled the form (is_filled) and if they have a Langchain report (responses_langchain_sentiment)
    const employeesWithStatus = await Promise.all((employees || []).map(async e => {
      // Check if a Langchain report exists for this employee
      const [reportRows] = await pool.execute(
        `SELECT 1 FROM responses_langchain_sentiment WHERE employeesID = ? LIMIT 1`,
        [e.employeesID]
      );
      return {
        employeesID: e.employeesID,
        name: e.name,
        email: e.email,
        role: e.role,
        hasReport: reportRows.length > 0,
        hasFilledForm: !!e.is_filled,
      };
    }));

    return res.json({ employees: employeesWithStatus, company });
  } catch (error) {
    console.error("Error fetching employees:", error);
    res.status(500).json({ error: "Failed to fetch employees" });
  }
});

// Get sentiment report for a specific employee
app.get(
  "/api/reports/sentiment/:employeeId",
  authenticateHR,
  async (req, res) => {
    try {
      const { employeeId } = req.params;
      const hrUser = req.employee;

      console.log("Fetching report for employeeId:", employeeId);
      console.log("HR User:", hrUser.employeesID);

      // Get HR user's company_id to ensure they can only view reports from their company
      const [hrResult] = await pool.execute(
        `SELECT company_id FROM ${TABLE_NAME} WHERE employeesID = ?`,
        [hrUser.employeesID]
      );

      if (!hrResult.length) {
        return res.status(404).json({ error: "HR user not found" });
      }

      const hrCompanyId = hrResult[0].company_id;
      console.log("HR CompanyId:", hrCompanyId);

      // Verify the employee belongs to the same company
      const [empResult] = await pool.execute(
        `SELECT company_id, name FROM ${TABLE_NAME} WHERE employeesID = ?`,
        [employeeId]
      );

      if (!empResult.length) {
        return res.status(404).json({ error: "Employee not found" });
      }

      console.log("Employee CompanyId:", empResult[0].company_id);
      console.log("Employee Name:", empResult[0].name);

      if (empResult[0].company_id !== hrCompanyId) {
        return res
          .status(403)
          .json({ error: "Access denied: Employee not in your company" });
      }

      // Get the sentiment report - EXACT MATCH ONLY
      console.log(
        "Searching for reports with employeeId:",
        employeeId,
        "Type:",
        typeof employeeId
      );

      // Only try exact match as requested
      const [reportResult] = await pool.execute(
        `SELECT * FROM responses_langchain_sentiment WHERE employeesID = ? ORDER BY created_at DESC LIMIT 1`,
        [employeeId]
      );

      console.log(
        "Exact match report query result length:",
        reportResult.length
      );
      if (reportResult.length > 0) {
        console.log("Found report for employee:", employeeId);
      }

      if (!reportResult.length) {
        // Check if the employee has filled the form
        const [empRow] = await pool.execute(
          `SELECT COALESCE(is_filled, 0) AS is_filled FROM ${TABLE_NAME} WHERE employeesID = ?`,
          [employeeId]
        );
        const hasFilledForm = empRow.length > 0 && !!empRow[0].is_filled;
        if (hasFilledForm) {
          return res.json({
            hasReport: false,
            hasFilledForm: true,
            message: "This employee has submitted the form but due to some technical issues the report is not generated. Please click on the button re-generate above this text.",
            employeeName: empResult[0].name,
          });
        } else {
          return res.json({
            hasReport: false,
            hasFilledForm: false,
            message: "This employee has not submitted their form yet",
            employeeName: empResult[0].name,
          });
        }
      }

      res.json({
        hasReport: true,
        report: reportResult[0],
        employeeName: empResult[0].name,
      });
    } catch (error) {
      console.error("Error fetching sentiment report:", error);
      res.status(500).json({ error: "Failed to fetch sentiment report" });
    }
  }
);

// Employee: retrieve own survey status (whether form filled)
app.get('/api/employees/me/status', authenticateEmployee, async (req, res) => {
  try {
    const empId = req.employee.employeesID;
    const [rows] = await pool.execute(
      `SELECT is_filled FROM ${TABLE_NAME} WHERE employeesID = ? LIMIT 1`,
      [empId]
    );
    if (!rows || !rows.length) return res.status(404).json({ success: false, message: 'Employee not found' });
    return res.json({ success: true, isFilled: !!rows[0].is_filled });
  } catch (err) {
    console.error('Error fetching employee status:', err && err.message ? err.message : err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Generic: retrieve survey status for any employee ID (authorized)
// Access allowed for: the employee themself, HRs, and Admins
app.get('/api/employees/:employeesID/status', authenticateToken, async (req, res) => {
  try {
    const targetId = String(req.params.employeesID || '').trim();
    if (!targetId) return res.status(400).json({ success: false, message: 'employeesID required' });

    const requester = req.employee || {};
    const requesterId = String(requester.employeesID || '').trim();
    const requesterRole = String(requester.role || '').trim();

    // Allow if same employee, or HR, or Admin
    if (requesterId !== targetId && requesterRole !== 'HR' && requesterRole !== 'Admin') {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const [rows] = await pool.execute(
      `SELECT is_filled FROM ${TABLE_NAME} WHERE employeesID = ? LIMIT 1`,
      [targetId]
    );
    if (!rows || !rows.length) return res.status(404).json({ success: false, message: 'Employee not found' });
    return res.json({ success: true, isFilled: !!rows[0].is_filled });
  } catch (err) {
    console.error('Error fetching employee status by id:', err && err.message ? err.message : err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// HR: Company report status (counts by employees.is_filled, exclude HR)
app.get('/api/company/report/status', authenticateHR, async (req, res) => {
  try {
    const hrUser = req.employee;

    // Resolve HR company
    const [hrRow] = await pool.execute(
      `SELECT e.company_id, c.company_name FROM ${TABLE_NAME} e LEFT JOIN companies c ON e.company_id = c.company_id WHERE e.employeesID = ? LIMIT 1`,
      [hrUser.employeesID]
    );
    if (!hrRow || !hrRow.length) return res.status(404).json({ error: 'HR user not found' });
    const companyId = hrRow[0].company_id;
    const companyName = hrRow[0].company_name || null;

    // Fetch employees (exclude HR)
    const [rows] = await pool.execute(
      `SELECT employeesID, name, email, role, COALESCE(is_filled, 0) AS is_filled FROM ${TABLE_NAME} WHERE company_id = ? AND role != 'HR' ORDER BY name`,
      [companyId]
    );
    const total = (rows || []).length;
    const filled = (rows || []).filter(r => !!r.is_filled).length;
    const notFilled = (rows || []).filter(r => !r.is_filled).map(r => ({
      employeesID: r.employeesID,
      name: r.name,
      role: r.role,
      email: r.email,
    }));

    return res.json({ companyId, companyName, total, filled, notFilled });
  } catch (err) {
    console.error('Error fetching company report status:', err);
    return res.status(500).json({ error: 'Failed to fetch company status' });
  }
});

// HR: Company report fetch (requires all employees filled)
app.get('/api/company/report', authenticateHR, async (req, res) => {
  try {
    const hrUser = req.employee;
    // Resolve HR company
    const [hrRow] = await pool.execute(
      `SELECT e.company_id, c.company_name FROM ${TABLE_NAME} e LEFT JOIN companies c ON e.company_id = c.company_id WHERE e.employeesID = ? LIMIT 1`,
      [hrUser.employeesID]
    );
    if (!hrRow || !hrRow.length) return res.status(404).json({ error: 'HR user not found' });
    const companyId = hrRow[0].company_id;
    const companyName = hrRow[0].company_name || null;

    // Check readiness: all non-HR employees filled
    const [rows] = await pool.execute(
      `SELECT COALESCE(is_filled, 0) AS is_filled FROM ${TABLE_NAME} WHERE company_id = ? AND role != 'HR'`,
      [companyId]
    );
    const total = (rows || []).length;
    const filled = (rows || []).filter(r => !!r.is_filled).length;
    if (total === 0) return res.status(404).json({ error: 'No employees to report' });
    if (filled !== total) return res.status(409).json({ error: 'Not all employees have submitted', total, filled });

    // Try to fetch company report from company_reports_sentiment (if present)
    try {
      const [reportRows] = await pool.execute(
        `SELECT * FROM company_reports_sentiment WHERE company_id = ? AND COALESCE(is_filled, 0) = 1 ORDER BY created_at DESC LIMIT 1`,
        [companyId]
      );
      if (reportRows && reportRows.length) {
        return res.json({ companyId, companyName, report: reportRows[0] });
      }
      // If table or row not found, fall through to 404
      return res.status(404).json({ error: 'Company report not ready' });
    } catch (e) {
      console.warn('company_reports_sentiment lookup failed or missing:', e && e.message ? e.message : e);
      return res.status(404).json({ error: 'Company report not ready' });
    }
  } catch (err) {
    console.error('Error fetching company report:', err);
    return res.status(500).json({ error: 'Failed to fetch company report' });
  }
});

// HR: Company report analysis trigger (generates company report)
app.post('/api/company/analyze', authenticateHR, async (req, res) => {
  try {
    const hrUser = req.employee;

    console.log("🤖 Starting company analysis for HR user:", hrUser.employeesID);

    // Resolve HR company
    const [hrRow] = await pool.execute(
      `SELECT e.company_id, c.company_name FROM ${TABLE_NAME} e LEFT JOIN companies c ON e.company_id = c.company_id WHERE e.employeesID = ? LIMIT 1`,
      [hrUser.employeesID]
    );

    if (!hrRow || !hrRow.length) {
      return res.status(404).json({ error: 'HR user company not found' });
    }

    const companyId = hrRow[0].company_id;
    const companyName = hrRow[0].company_name || null;

    console.log("🏢 Company info:", { companyId, companyName });

    // Check readiness: all non-HR employees must have filled their surveys
    const [rows] = await pool.execute(
      `SELECT COALESCE(is_filled, 0) AS is_filled FROM ${TABLE_NAME} WHERE company_id = ? AND role != 'HR'`,
      [companyId]
    );

    const total = (rows || []).length;
    const filled = (rows || []).filter(r => !!r.is_filled).length;

    if (total === 0) {
      return res.status(409).json({ error: 'No employees in company to analyze' });
    }

    if (filled !== total) {
      return res.status(409).json({
        error: `Not all employees have submitted surveys: ${filled}/${total} completed`,
        details: { filled, total }
      });
    }

    console.log(`✅ All employees have submitted surveys: ${filled}/${total}`);

    // Use the same triggerCompanyAnalysis function for consistency
    console.log("🔄 Triggering full analysis (individual reports + company report)...");

    try {
      await triggerCompanyAnalysis(companyId);

      // Return success response
      return res.json({
        success: true,
        message: 'Individual employee reports and company analysis completed successfully',
        companyId: companyId,
        companyName: companyName,
        timestamp: new Date().toISOString()
      });

    } catch (flaskError) {
      console.error("❌ Flask company analysis error:", flaskError.message);

      if (flaskError.code === 'ECONNREFUSED') {
        return res.status(503).json({
          error: 'AI analysis service is unavailable',
          details: 'Please ensure the Flask sentiment analysis service is running'
        });
      }

      if (flaskError.response) {
        console.error("Flask error response:", flaskError.response.data);
        return res.status(500).json({
          error: 'Company analysis failed',
          details: flaskError.response.data.error || 'Unknown error from analysis service'
        });
      }

      return res.status(500).json({
        error: 'Failed to connect to analysis service',
        details: flaskError.message
      });
    }

  } catch (error) {
    console.error("❌ Company analysis endpoint error:", error);
    return res.status(500).json({
      error: 'Internal server error during company analysis',
      details: error.message
    });
  }
});

// NEW: Manual trigger for AI analysis (for testing/retrying)
app.post(
  "/api/trigger-ai-analysis/:employeeId",
  authenticateHR,
  async (req, res) => {
    try {
      const { employeeId } = req.params;
      const hrUser = req.employee;

      // Verify HR user has access to this employee
      const [hrResult] = await pool.execute(
        `SELECT e.company_id, c.company_name FROM ${TABLE_NAME} e LEFT JOIN companies c ON e.company_id = c.company_id WHERE e.employeesID = ? LIMIT 1`,
        [hrUser.employeesID]
      );

      if (!hrResult.length) {
        return res.status(404).json({ error: "HR user not found" });
      }

      const [empResult] = await pool.execute(
        `SELECT e.company_id, c.company_name, e.name FROM ${TABLE_NAME} e LEFT JOIN companies c ON e.company_id = c.company_id WHERE e.employeesID = ? LIMIT 1`,
        [employeeId]
      );

      if (!empResult.length) {
        return res.status(404).json({ error: "Employee not found" });
      }

      if (empResult[0].company_id !== hrResult[0].company_id) {
        return res
          .status(403)
          .json({ error: "Access denied: Employee not in your company" });
      }

      res.json({ success: true, message: "AI trigger started" });
    } catch (error) {
      console.error("Trigger AI error:", error);
      res.status(500).json({ error: "Failed to trigger AI" });
    }
  }
);

// NEW: Regenerate employee report endpoint
app.post(
  "/api/reports/regenerate/:employeeId",
  authenticateHR,
  async (req, res) => {
    try {
      const { employeeId } = req.params;
      const hrUser = req.employee;

      console.log("🔄 Regenerating report for employeeId:", employeeId);

      // Get HR user's company to ensure they can only regenerate reports from their company
      const [hrResult] = await pool.execute(
        `SELECT e.company_id, c.company_name FROM ${TABLE_NAME} e
         LEFT JOIN companies c ON e.company_id = c.company_id
         WHERE e.employeesID = ?`,
        [hrUser.employeesID]
      );

      if (!hrResult.length) {
        return res.status(404).json({ error: "HR user company not found" });
      }

      const hrCompanyId = hrResult[0].company_id;
      const companyName = hrResult[0].company_name;

      // Verify the employee belongs to the same company
      const [empResult] = await pool.execute(
        `SELECT company_id, name FROM ${TABLE_NAME} WHERE employeesID = ?`,
        [employeeId]
      );

      if (!empResult.length) {
        return res.status(404).json({ error: "Employee not found" });
      }

      if (empResult[0].company_id !== hrCompanyId) {
        return res.status(403).json({
          error: "Access denied: Employee not in your company"
        });
      }

      // Call Flask regenerate endpoint
      const payload = {
        employeeId: employeeId,
        company: companyName
      };

      console.log("➡️ Calling Flask regenerate endpoint with payload:", payload);
      console.log("Flask URL:", `${FLASK_BASE_URL}/regenerate-report`);

      const flaskResponse = await axios.post(
        `${FLASK_BASE_URL}/regenerate-report`,
        payload,
        {
          timeout: FLASK_TIMEOUT,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );

      console.log("✅ Flask regenerate response status:", flaskResponse.status);

      if (flaskResponse.status === 200) {
        res.json({
          success: true,
          message: `Report successfully regenerated for ${empResult[0].name}`,
          employeeName: empResult[0].name,
          data: flaskResponse.data
        });
      } else {
        throw new Error(`Flask returned status ${flaskResponse.status}`);
      }

    } catch (error) {
      console.error("❌ Error regenerating report:", error.message);

      if (error.response) {
        // Flask API returned an error
        console.error("Flask error response:", error.response.data);
        res.status(error.response.status || 500).json({
          success: false,
          error: error.response.data?.error || "Flask service error",
          details: error.response.data
        });
      } else if (error.code === 'ECONNREFUSED') {
        res.status(503).json({
          success: false,
          error: "AI service unavailable. Please try again later."
        });
      } else {
        res.status(500).json({
          success: false,
          error: "Failed to regenerate report",
          details: error.message
        });
      }
    }
  }
);

// NEW: Check Flask agent status
app.get("/api/agent-status", authenticateToken, async (req, res) => {
  try {
    const response = await axios.get(`${FLASK_BASE_URL}/health`, {
      timeout: 5000,
    });
    res.json({
      status: "online",
      agentResponse: response.data,
      timestamp: new Date().toISOString(),
      endpoint: FLASK_BASE_URL,
    });
  } catch (error) {
    res.json({
      status: "offline",
      error: error.message,
      timestamp: new Date().toISOString(),
      endpoint: FLASK_BASE_URL,
    });
  }
});

// Health check
app.get("/api/health", (_, res) => {
  res.json({ status: "OK", message: "ForteAI Server is running" });
});

// Debug endpoint
app.get("/api/debug/employees", async (_, res) => {
  try {
    const [tableInfo] = await pool.execute(`DESCRIBE ${TABLE_NAME}`);
    const [sample] = await pool.execute(
      `SELECT e.employeesID, e.name, e.role, e.company_id, c.company_name FROM ${TABLE_NAME} e LEFT JOIN companies c ON e.company_id = c.company_id LIMIT 5`
    );
    const [roleCounts] = await pool.execute(
      `SELECT role, COUNT(*) as count FROM ${TABLE_NAME} GROUP BY role`
    );

    res.json({
      success: true,
      tableStructure: tableInfo,
      sampleEmployees: sample,
      roleCounts,
      totalEmployees: sample.length,
    });
  } catch (error) {
    console.error("Debug error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Debug endpoint: show Responses_Sentiment schema and sample rows
app.get("/api/debug/responses_table", async (_, res) => {
  try {
    const [desc] = await pool.execute("DESCRIBE Responses_Sentiment");
    const [rows] = await pool.execute(
      "SELECT * FROM Responses_Sentiment LIMIT 10"
    );
    res.json({ success: true, description: desc, sample: rows });
  } catch (err) {
    console.error("Responses table debug failed:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 ForteAI Server running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
  console.log(`🤖 Flask Agent URL: ${FLASK_BASE_URL}`);
});

// Graceful shutdown handling
process.on("SIGINT", async () => {
  console.log("\n🛑 Graceful shutdown initiated...");
  try {
    console.log("📦 Closing database connections...");
    await pool.end();
    console.log("✅ Database connections closed");
    console.log("👋 Server shutdown complete");
    process.exit(0);
  } catch (error) {
    console.error("❌ Error during shutdown:", error);
    process.exit(1);
  }
});

// Helpful diagnostic handlers
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});
#temporary line added
