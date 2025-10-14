const express = require('express');
const archiver = require('archiver');

// Admin feedback routes
module.exports = (pool) => {
  const router = express.Router();

  // GET /company/:company/feedback - fetch HR feedback for a company
  router.get('/company/:company/feedback', async (req, res) => {
    try {
      const companyParam = req.params.company;
      // resolve company_id
      let companyId = Number(companyParam);
      if (Number.isNaN(companyId)) {
        const [rows] = await pool.execute(
          'SELECT company_id FROM companies WHERE company_name = ? LIMIT 1',
          [companyParam]
        );
        if (!rows.length) {
          return res.status(404).json({ success: false, message: 'Company not found' });
        }
        companyId = rows[0].company_id;
      }
      // fetch all HR employees for this company
      const [hrs] = await pool.execute(
        'SELECT employeesID, name FROM employees WHERE company_id = ? AND role = ?',
        [companyId, 'HR']
      );
      if (!hrs.length) {
        return res.json({ success: true, feedbackList: [] });
      }
      // fetch active feedback questions and options
      const [questions] = await pool.execute(
        'SELECT question_id, question_text, question_type FROM hr_feedback_questions WHERE is_active = 1 ORDER BY question_id'
      );
      const [options] = await pool.execute(
        'SELECT option_id, option_text FROM hr_feedback_options'
      );
      // assemble feedback list for each HR
      const feedbackList = [];
      for (const hr of hrs) {
        const [responses] = await pool.execute(
          'SELECT question_id, option_id, response_text FROM hr_feedback_responses WHERE employeesID = ?',
          [hr.employeesID]
        );
        const feedback = questions.map((q) => {
          const resp = responses.find((r) => r.question_id === q.question_id) || {};
          const answer = q.question_type === 'text' || q.question_type === 'amount'
            ? resp.response_text || ''
            : options.find((o) => o.option_id === resp.option_id)?.option_text || '';
          return { question_id: q.question_id, question_text: q.question_text, question_type: q.question_type, answer };
        });
        feedbackList.push({ employeesID: hr.employeesID, name: hr.name, feedback });
      }
      return res.json({ success: true, feedbackList });
    } catch (err) {
      console.error('Error fetching company feedback', err);
      return res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  // GET /download/all-reports - Download master ZIP with all company reports + combined CSVs
  // OPTIMIZED: Streams data directly without creating nested ZIPs in memory
  router.get('/download/all-reports', async (req, res) => {
    try {
      console.log('Starting master ZIP generation...');

      // Set response headers for ZIP download
      const timestamp = new Date().toISOString().split('T')[0].replace(/-/g, '');
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="master_reports_${timestamp}.zip"`);

      // Create master ZIP archive
      const masterArchive = archiver('zip', { zlib: { level: 5 } }); // Reduced compression for speed
      
      masterArchive.on('error', (err) => {
        console.error('Master archive error:', err);
        if (!res.headersSent) {
          res.status(500).json({ success: false, message: 'Error creating master ZIP file' });
        }
      });

      // Pipe master archive to response
      masterArchive.pipe(res);

      // Get all companies with complete data in ONE query
      const [companies] = await pool.execute(`
        SELECT DISTINCT 
          c.company_id, 
          c.company_name,
          (SELECT COUNT(*) FROM employees WHERE company_id = c.company_id AND role != 'HR') as total_employees,
          (SELECT COUNT(*) FROM employees WHERE company_id = c.company_id AND role != 'HR' AND COALESCE(is_filled, 0) = 1) as filled_employees,
          (SELECT COUNT(*) FROM responses_langchain_sentiment 
           WHERE employeesID IN (SELECT employeesID FROM employees WHERE company_id = c.company_id AND role != 'HR')) as reports_count,
          (SELECT COUNT(*) FROM company_reports_sentiment WHERE company_id = c.company_id AND COALESCE(is_filled, 0) = 1) as has_company_report
        FROM companies c
        WHERE EXISTS (SELECT 1 FROM employees WHERE company_id = c.company_id)
        HAVING total_employees > 0 
          AND total_employees = filled_employees 
          AND total_employees = reports_count 
          AND has_company_report > 0
        ORDER BY c.company_name
      `);

      console.log(`Found ${companies.length} companies with complete data`);

      const allCompanyReports = [];
      const allHRFeedbacks = [];

      // Get questions once (reuse for all companies)
      const [questions] = await pool.execute(`
        SELECT mq.question_number, fq.question_text, mq.question_type, mq.options_questions
        FROM FormQuestions_Sentiment fq
        JOIN MasterQuestions_Sentiment mq ON fq.master_question_id = mq.master_question_id
        ORDER BY mq.question_number
      `);

      // Get HR feedback questions once
      const [hrQuestions] = await pool.execute(
        'SELECT question_id, question_text, question_type FROM hr_feedback_questions WHERE is_active = 1 ORDER BY question_id'
      );
      const [hrOptions] = await pool.execute(
        'SELECT option_id, option_text FROM hr_feedback_options'
      );

      // Process each company
      for (const company of companies) {
        const { company_id: companyId, company_name: companyName } = company;
        console.log(`Processing ${companyName}...`);

        // ===== CSV 1: Employee Responses Matrix =====
        const [employees] = await pool.execute(
          'SELECT employeesID, name FROM employees WHERE company_id = ? AND role != ? ORDER BY employeesID',
          [companyId, 'HR']
        );

        const responseMatrix = [];
        const headerRow = ['Employee ID', 'Employee Name', ...questions.map(q => `Q${q.question_number}: ${q.question_text}`)];
        responseMatrix.push(headerRow.join(','));

        // Fetch all responses for this company at once
        const employeeIds = employees.map(e => e.employeesID);
        const [allResponses] = await pool.execute(`
          SELECT rs.employeesID, rs.answer_text, rs.answer_choice, mq.question_number, 
                 mq.question_type, mq.options_questions
          FROM Responses_Sentiment rs
          JOIN FormQuestions_Sentiment fq ON rs.form_question_id = fq.form_question_id
          JOIN MasterQuestions_Sentiment mq ON fq.master_question_id = mq.master_question_id
          WHERE rs.employeesID IN (${employeeIds.map(() => '?').join(',')})
          ORDER BY rs.employeesID, mq.question_number
        `, employeeIds);

        // Group responses by employee
        const responsesByEmployee = {};
        allResponses.forEach(r => {
          if (!responsesByEmployee[r.employeesID]) {
            responsesByEmployee[r.employeesID] = {};
          }
          
          let answer = '';
          if (r.question_type === 'text') {
            answer = r.answer_text || '';
          } else {
            if (r.answer_choice && r.options_questions) {
              try {
                const options = typeof r.options_questions === 'string' 
                  ? JSON.parse(r.options_questions) 
                  : r.options_questions;
                const selectedOption = options.find(opt => String(opt.value) === String(r.answer_choice));
                answer = selectedOption ? selectedOption.label : r.answer_choice;
              } catch (e) {
                answer = r.answer_choice || '';
              }
            } else {
              answer = r.answer_choice || '';
            }
          }
          
          responsesByEmployee[r.employeesID][r.question_number] = answer.replace(/"/g, '""');
        });

        // Build CSV rows
        for (const emp of employees) {
          const answerMap = responsesByEmployee[emp.employeesID] || {};
          const row = [
            emp.employeesID,
            emp.name || '',
            ...questions.map(q => `"${answerMap[q.question_number] || ''}"`)
          ];
          responseMatrix.push(row.join(','));
        }

        // Add to master ZIP directly (no intermediate ZIP)
        masterArchive.append(responseMatrix.join('\n'), { 
          name: `${companyName}/${companyName}_responses_sentiment_matrix.csv` 
        });

        // ===== CSV 2: LangChain Sentiment Analysis =====
        const [langchainData] = await pool.execute(`
          SELECT 
            employeesID, company, positive_sentiment, neutral_sentiment, negative_sentiment,
            summary_opinion, key_positive_1, key_positive_2, key_positive_3,
            attrition_factor_1, attrition_problem_1, retention_strategy_1,
            attrition_factor_2, attrition_problem_2, retention_strategy_2,
            attrition_factor_3, attrition_problem_3, retention_strategy_3,
            created_at
          FROM responses_langchain_sentiment
          WHERE employeesID IN (${employeeIds.map(() => '?').join(',')})
          ORDER BY employeesID
        `, employeeIds);

        const langchainCSV = [];
        langchainCSV.push([
          'Employee ID', 'Company', 'Positive Sentiment %', 'Neutral Sentiment %', 'Negative Sentiment %',
          'Summary Opinion', 'Key Positive 1', 'Key Positive 2', 'Key Positive 3',
          'Attrition Factor 1', 'Attrition Problem 1', 'Retention Strategy 1',
          'Attrition Factor 2', 'Attrition Problem 2', 'Retention Strategy 2',
          'Attrition Factor 3', 'Attrition Problem 3', 'Retention Strategy 3',
          'Created At'
        ].join(','));

        langchainData.forEach(row => {
          const csvRow = [
            row.employeesID,
            row.company || '',
            row.positive_sentiment || 0,
            row.neutral_sentiment || 0,
            row.negative_sentiment || 0,
            `"${(row.summary_opinion || '').replace(/"/g, '""')}"`,
            `"${(row.key_positive_1 || '').replace(/"/g, '""')}"`,
            `"${(row.key_positive_2 || '').replace(/"/g, '""')}"`,
            `"${(row.key_positive_3 || '').replace(/"/g, '""')}"`,
            `"${(row.attrition_factor_1 || '').replace(/"/g, '""')}"`,
            `"${(row.attrition_problem_1 || '').replace(/"/g, '""')}"`,
            `"${(row.retention_strategy_1 || '').replace(/"/g, '""')}"`,
            `"${(row.attrition_factor_2 || '').replace(/"/g, '""')}"`,
            `"${(row.attrition_problem_2 || '').replace(/"/g, '""')}"`,
            `"${(row.retention_strategy_2 || '').replace(/"/g, '""')}"`,
            `"${(row.attrition_factor_3 || '').replace(/"/g, '""')}"`,
            `"${(row.attrition_problem_3 || '').replace(/"/g, '""')}"`,
            `"${(row.retention_strategy_3 || '').replace(/"/g, '""')}"`,
            row.created_at || ''
          ];
          langchainCSV.push(csvRow.join(','));
        });

        masterArchive.append(langchainCSV.join('\n'), { 
          name: `${companyName}/${companyName}_responses_langchain_sentiment.csv` 
        });

        // ===== COLLECT DATA FOR COMBINED CSV FILES =====
        
        // Collect company report data
        const [companyReport] = await pool.execute(`
          SELECT 
            company_id, positive_sentiment, neutral_sentiment, negative_sentiment,
            summary_opinion, key_positive_1, key_positive_2, key_positive_3,
            attrition_factor_1, attrition_problem_1, retention_strategy_1,
            attrition_factor_2, attrition_problem_2, retention_strategy_2,
            attrition_factor_3, attrition_problem_3, retention_strategy_3,
            created_at, is_filled
          FROM company_reports_sentiment
          WHERE company_id = ?
          ORDER BY created_at DESC
          LIMIT 1
        `, [companyId]);

        if (companyReport.length > 0) {
          allCompanyReports.push({
            ...companyReport[0],
            company_name: companyName
          });
        }

        // Collect HR feedback data
        const [hrs] = await pool.execute(
          'SELECT employeesID, name FROM employees WHERE company_id = ? AND role = ?',
          [companyId, 'HR']
        );

        if (hrs.length > 0) {
          const hrIds = hrs.map(h => h.employeesID);
          const [hrResponses] = await pool.execute(
            `SELECT employeesID, question_id, option_id, response_text 
             FROM hr_feedback_responses 
             WHERE employeesID IN (${hrIds.map(() => '?').join(',')})`,
            hrIds
          );

          // Group by employee
          const responsesByHR = {};
          hrResponses.forEach(r => {
            if (!responsesByHR[r.employeesID]) responsesByHR[r.employeesID] = [];
            responsesByHR[r.employeesID].push(r);
          });

          for (const hr of hrs) {
            const responses = responsesByHR[hr.employeesID] || [];
            const feedback = hrQuestions.map((q) => {
              const resp = responses.find((r) => r.question_id === q.question_id) || {};
              const answer = q.question_type === 'text' || q.question_type === 'amount'
                ? resp.response_text || ''
                : hrOptions.find((o) => o.option_id === resp.option_id)?.option_text || '';
              return { question_id: q.question_id, question_text: q.question_text, answer };
            });

            allHRFeedbacks.push({
              company_name: companyName,
              employeesID: hr.employeesID,
              name: hr.name,
              feedback
            });
          }
        }
      }

      console.log(`Processed ${companies.length} companies`);

      // ===== CREATE COMBINED CSV FILES =====

      // Combined Company Reports CSV
      const companyReportsCSV = [];
      companyReportsCSV.push([
        'Company ID', 'Company Name', 'Positive Sentiment %', 'Neutral Sentiment %', 'Negative Sentiment %',
        'Summary Opinion', 'Key Positive 1', 'Key Positive 2', 'Key Positive 3',
        'Attrition Factor 1', 'Attrition Problem 1', 'Retention Strategy 1',
        'Attrition Factor 2', 'Attrition Problem 2', 'Retention Strategy 2',
        'Attrition Factor 3', 'Attrition Problem 3', 'Retention Strategy 3',
        'Created At', 'Is Filled'
      ].join(','));

      allCompanyReports.forEach(row => {
        const csvRow = [
          row.company_id,
          row.company_name,
          row.positive_sentiment || 0,
          row.neutral_sentiment || 0,
          row.negative_sentiment || 0,
          `"${(row.summary_opinion || '').replace(/"/g, '""')}"`,
          `"${(row.key_positive_1 || '').replace(/"/g, '""')}"`,
          `"${(row.key_positive_2 || '').replace(/"/g, '""')}"`,
          `"${(row.key_positive_3 || '').replace(/"/g, '""')}"`,
          `"${(row.attrition_factor_1 || '').replace(/"/g, '""')}"`,
          `"${(row.attrition_problem_1 || '').replace(/"/g, '""')}"`,
          `"${(row.retention_strategy_1 || '').replace(/"/g, '""')}"`,
          `"${(row.attrition_factor_2 || '').replace(/"/g, '""')}"`,
          `"${(row.attrition_problem_2 || '').replace(/"/g, '""')}"`,
          `"${(row.retention_strategy_2 || '').replace(/"/g, '""')}"`,
          `"${(row.attrition_factor_3 || '').replace(/"/g, '""')}"`,
          `"${(row.attrition_problem_3 || '').replace(/"/g, '""')}"`,
          `"${(row.retention_strategy_3 || '').replace(/"/g, '""')}"`,
          row.created_at || '',
          row.is_filled || 0
        ];
        companyReportsCSV.push(csvRow.join(','));
      });

      masterArchive.append(companyReportsCSV.join('\n'), { name: 'all_companies_reports.csv' });

      // Combined HR Feedback CSV
      const hrFeedbackCSV = [];
      
      if (allHRFeedbacks.length > 0 && allHRFeedbacks[0].feedback) {
        const questionHeaders = allHRFeedbacks[0].feedback.map(f => f.question_text);
        hrFeedbackCSV.push(['Company Name', 'HR Employee ID', 'HR Name', ...questionHeaders].join(','));

        allHRFeedbacks.forEach(hr => {
          const answers = hr.feedback.map(f => `"${(f.answer || '').replace(/"/g, '""')}"`);
          const csvRow = [hr.company_name, hr.employeesID, hr.name || '', ...answers];
          hrFeedbackCSV.push(csvRow.join(','));
        });
      } else {
        hrFeedbackCSV.push(['Company Name', 'HR Employee ID', 'HR Name', 'Note'].join(','));
        hrFeedbackCSV.push(['"No HR feedback data available"', '', '', ''].join(','));
      }

      masterArchive.append(hrFeedbackCSV.join('\n'), { name: 'all_hr_feedbacks.csv' });

      // Finalize master archive
      await masterArchive.finalize();

      console.log('Master ZIP generation complete');

    } catch (err) {
      console.error('Error generating master reports ZIP:', err);
      if (!res.headersSent) {
        return res.status(500).json({ success: false, message: 'Server error generating master reports' });
      }
    }
  });

  // GET /download/reports - Download all company reports as ZIP with CSV files
  // Only works if all employees have filled forms and generated reports
  router.get('/download/reports', async (req, res) => {
    try {
      const companyParam = req.query.company;
      if (!companyParam) {
        return res.status(400).json({ success: false, message: 'Company parameter required' });
      }

      // Resolve company_id
      let companyId = Number(companyParam);
      if (Number.isNaN(companyId)) {
        const [rows] = await pool.execute(
          'SELECT company_id FROM companies WHERE company_name = ? LIMIT 1',
          [companyParam]
        );
        if (!rows.length) {
          return res.status(404).json({ success: false, message: 'Company not found' });
        }
        companyId = rows[0].company_id;
      }

      // Get company name for ZIP filename
      const [companyRows] = await pool.execute(
        'SELECT company_name FROM companies WHERE company_id = ? LIMIT 1',
        [companyId]
      );
      const companyName = companyRows.length ? companyRows[0].company_name : `company_${companyId}`;

      // ===== VALIDATION: Check if all employees have filled forms and generated reports =====
      const [validationEmployees] = await pool.execute(
        'SELECT employeesID, COALESCE(is_filled, 0) as is_filled FROM employees WHERE company_id = ? AND role != ?',
        [companyId, 'HR']
      );

      if (validationEmployees.length === 0) {
        return res.status(404).json({ success: false, message: 'No employees found for this company' });
      }

      // Check if all employees have filled the form
      const allFilled = validationEmployees.every(emp => emp.is_filled === 1);
      if (!allFilled) {
        const filledCount = validationEmployees.filter(emp => emp.is_filled === 1).length;
        return res.status(409).json({ 
          success: false, 
          message: `Not all employees have filled the form. ${filledCount}/${validationEmployees.length} completed.` 
        });
      }

      // Check if all employees have generated reports (langchain sentiment)
      const [reportCounts] = await pool.execute(`
        SELECT COUNT(*) as count 
        FROM responses_langchain_sentiment 
        WHERE employeesID IN (SELECT employeesID FROM employees WHERE company_id = ? AND role != ?)
      `, [companyId, 'HR']);

      if (reportCounts[0].count !== validationEmployees.length) {
        return res.status(409).json({ 
          success: false, 
          message: `Not all employee reports have been generated. ${reportCounts[0].count}/${validationEmployees.length} reports available.` 
        });
      }

      // Check if company report exists
      const [companyReportCheck] = await pool.execute(
        'SELECT 1 FROM company_reports_sentiment WHERE company_id = ? AND COALESCE(is_filled, 0) = 1 LIMIT 1',
        [companyId]
      );

      if (companyReportCheck.length === 0) {
        return res.status(409).json({ 
          success: false, 
          message: 'Company report not yet generated. Please generate the company report first.' 
        });
      }

      // Set response headers for ZIP download
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${companyName}_reports.zip"`);

      // Create ZIP archive
      const archive = archiver('zip', { zlib: { level: 9 } });
      
      archive.on('error', (err) => {
        console.error('Archive error:', err);
        res.status(500).json({ success: false, message: 'Error creating ZIP file' });
      });

      // Pipe archive to response
      archive.pipe(res);

      // ===== CSV 1: Employee Responses Matrix (Questions as columns, Employees as rows) =====
      const [questions] = await pool.execute(`
        SELECT mq.question_number, fq.question_text, mq.question_type, mq.options_questions
        FROM FormQuestions_Sentiment fq
        JOIN MasterQuestions_Sentiment mq ON fq.master_question_id = mq.master_question_id
        ORDER BY mq.question_number
      `);

      const [employees] = await pool.execute(
        'SELECT employeesID, name FROM employees WHERE company_id = ? AND role != ? ORDER BY employeesID',
        [companyId, 'HR']
      );

      // Build responses matrix
      const responseMatrix = [];
      const headerRow = ['Employee ID', 'Employee Name', ...questions.map(q => `Q${q.question_number}: ${q.question_text}`)];
      responseMatrix.push(headerRow.join(','));

      for (const emp of employees) {
        const [responses] = await pool.execute(`
          SELECT rs.form_question_id, rs.answer_text, rs.answer_choice, mq.question_number, 
                 mq.question_type, mq.options_questions
          FROM Responses_Sentiment rs
          JOIN FormQuestions_Sentiment fq ON rs.form_question_id = fq.form_question_id
          JOIN MasterQuestions_Sentiment mq ON fq.master_question_id = mq.master_question_id
          WHERE rs.employeesID = ?
          ORDER BY mq.question_number
        `, [emp.employeesID]);

        const answerMap = {};
        responses.forEach(r => {
          let answer = '';
          
          if (r.question_type === 'text') {
            // For text questions, use answer_text directly
            answer = r.answer_text || '';
          } else {
            // For multiple choice, get the actual option text
            if (r.answer_choice && r.options_questions) {
              try {
                const options = typeof r.options_questions === 'string' 
                  ? JSON.parse(r.options_questions) 
                  : r.options_questions;
                
                // Find the option that matches the selected value
                const selectedOption = options.find(opt => String(opt.value) === String(r.answer_choice));
                answer = selectedOption ? selectedOption.label : r.answer_choice;
              } catch (e) {
                console.error('Error parsing options for question:', r.question_number, e);
                answer = r.answer_choice || '';
              }
            } else {
              answer = r.answer_choice || '';
            }
          }
          
          answerMap[r.question_number] = answer.replace(/"/g, '""'); // Escape quotes
        });

        const row = [
          emp.employeesID,
          emp.name || '',
          ...questions.map(q => `"${answerMap[q.question_number] || ''}"`)
        ];
        responseMatrix.push(row.join(','));
      }

      archive.append(responseMatrix.join('\n'), { name: 'responses_sentiment_matrix.csv' });

      // ===== CSV 2: LangChain Sentiment Analysis for Each Employee =====
      const [langchainData] = await pool.execute(`
        SELECT 
          employeesID, company, positive_sentiment, neutral_sentiment, negative_sentiment,
          summary_opinion, key_positive_1, key_positive_2, key_positive_3,
          attrition_factor_1, attrition_problem_1, retention_strategy_1,
          attrition_factor_2, attrition_problem_2, retention_strategy_2,
          attrition_factor_3, attrition_problem_3, retention_strategy_3,
          created_at
        FROM responses_langchain_sentiment
        WHERE employeesID IN (SELECT employeesID FROM employees WHERE company_id = ?)
        ORDER BY employeesID
      `, [companyId]);

      const langchainCSV = [];
      if (langchainData.length > 0) {
        // Header
        langchainCSV.push([
          'Employee ID', 'Company', 'Positive Sentiment %', 'Neutral Sentiment %', 'Negative Sentiment %',
          'Summary Opinion', 'Key Positive 1', 'Key Positive 2', 'Key Positive 3',
          'Attrition Factor 1', 'Attrition Problem 1', 'Retention Strategy 1',
          'Attrition Factor 2', 'Attrition Problem 2', 'Retention Strategy 2',
          'Attrition Factor 3', 'Attrition Problem 3', 'Retention Strategy 3',
          'Created At'
        ].join(','));

        // Data rows
        langchainData.forEach(row => {
          const csvRow = [
            row.employeesID,
            row.company || '',
            row.positive_sentiment || 0,
            row.neutral_sentiment || 0,
            row.negative_sentiment || 0,
            `"${(row.summary_opinion || '').replace(/"/g, '""')}"`,
            `"${(row.key_positive_1 || '').replace(/"/g, '""')}"`,
            `"${(row.key_positive_2 || '').replace(/"/g, '""')}"`,
            `"${(row.key_positive_3 || '').replace(/"/g, '""')}"`,
            `"${(row.attrition_factor_1 || '').replace(/"/g, '""')}"`,
            `"${(row.attrition_problem_1 || '').replace(/"/g, '""')}"`,
            `"${(row.retention_strategy_1 || '').replace(/"/g, '""')}"`,
            `"${(row.attrition_factor_2 || '').replace(/"/g, '""')}"`,
            `"${(row.attrition_problem_2 || '').replace(/"/g, '""')}"`,
            `"${(row.retention_strategy_2 || '').replace(/"/g, '""')}"`,
            `"${(row.attrition_factor_3 || '').replace(/"/g, '""')}"`,
            `"${(row.attrition_problem_3 || '').replace(/"/g, '""')}"`,
            `"${(row.retention_strategy_3 || '').replace(/"/g, '""')}"`,
            row.created_at || ''
          ];
          langchainCSV.push(csvRow.join(','));
        });
      }

      archive.append(langchainCSV.join('\n'), { name: 'responses_langchain_sentiment.csv' });

      // ===== CSV 3: Company Report =====
      const [companyReport] = await pool.execute(`
        SELECT 
          company_id, positive_sentiment, neutral_sentiment, negative_sentiment,
          summary_opinion, key_positive_1, key_positive_2, key_positive_3,
          attrition_factor_1, attrition_problem_1, retention_strategy_1,
          attrition_factor_2, attrition_problem_2, retention_strategy_2,
          attrition_factor_3, attrition_problem_3, retention_strategy_3,
          created_at, is_filled
        FROM company_reports_sentiment
        WHERE company_id = ?
        ORDER BY created_at DESC
        LIMIT 1
      `, [companyId]);

      const companyReportCSV = [];
      companyReportCSV.push([
        'Company ID', 'Company Name', 'Positive Sentiment %', 'Neutral Sentiment %', 'Negative Sentiment %',
        'Summary Opinion', 'Key Positive 1', 'Key Positive 2', 'Key Positive 3',
        'Attrition Factor 1', 'Attrition Problem 1', 'Retention Strategy 1',
        'Attrition Factor 2', 'Attrition Problem 2', 'Retention Strategy 2',
        'Attrition Factor 3', 'Attrition Problem 3', 'Retention Strategy 3',
        'Created At', 'Is Filled'
      ].join(','));

      if (companyReport.length > 0) {
        const row = companyReport[0];
        const csvRow = [
          row.company_id,
          companyName,
          row.positive_sentiment || 0,
          row.neutral_sentiment || 0,
          row.negative_sentiment || 0,
          `"${(row.summary_opinion || '').replace(/"/g, '""')}"`,
          `"${(row.key_positive_1 || '').replace(/"/g, '""')}"`,
          `"${(row.key_positive_2 || '').replace(/"/g, '""')}"`,
          `"${(row.key_positive_3 || '').replace(/"/g, '""')}"`,
          `"${(row.attrition_factor_1 || '').replace(/"/g, '""')}"`,
          `"${(row.attrition_problem_1 || '').replace(/"/g, '""')}"`,
          `"${(row.retention_strategy_1 || '').replace(/"/g, '""')}"`,
          `"${(row.attrition_factor_2 || '').replace(/"/g, '""')}"`,
          `"${(row.attrition_problem_2 || '').replace(/"/g, '""')}"`,
          `"${(row.retention_strategy_2 || '').replace(/"/g, '""')}"`,
          `"${(row.attrition_factor_3 || '').replace(/"/g, '""')}"`,
          `"${(row.attrition_problem_3 || '').replace(/"/g, '""')}"`,
          `"${(row.retention_strategy_3 || '').replace(/"/g, '""')}"`,
          row.created_at || '',
          row.is_filled || 0
        ];
        companyReportCSV.push(csvRow.join(','));
      }

      archive.append(companyReportCSV.join('\n'), { name: 'company_report.csv' });

      // Finalize the archive
      await archive.finalize();

    } catch (err) {
      console.error('Error generating reports ZIP:', err);
      if (!res.headersSent) {
        return res.status(500).json({ success: false, message: 'Server error generating reports' });
      }
    }
  });

  // POST /company/:company/reset - Reset company data after downloading reports
  // Clears: Responses_Sentiment, responses_langchain_sentiment, company_reports_sentiment
  // Resets is_filled flag for all employees
  router.post('/company/:company/reset', async (req, res) => {
    const connection = await pool.getConnection();
    try {
      const companyParam = req.params.company;
      const onlyFilled = req.query.onlyFilled === 'true'; // Optional: only reset filled employees

      // Resolve company_id
      let companyId = Number(companyParam);
      if (Number.isNaN(companyId)) {
        const [rows] = await connection.execute(
          'SELECT company_id FROM companies WHERE company_name = ? LIMIT 1',
          [companyParam]
        );
        if (!rows.length) {
          return res.status(404).json({ success: false, message: 'Company not found' });
        }
        companyId = rows[0].company_id;
      }

      // Start transaction
      await connection.beginTransaction();

      // Get all employee IDs for this company
      const whereClause = onlyFilled 
        ? 'WHERE company_id = ? AND role != ? AND COALESCE(is_filled, 0) = 1'
        : 'WHERE company_id = ? AND role != ?';
      
      const [employees] = await connection.execute(
        `SELECT employeesID FROM employees ${whereClause}`,
        [companyId, 'HR']
      );

      if (employees.length === 0) {
        await connection.rollback();
        return res.json({ 
          success: true, 
          message: 'No employees to reset',
          deletedResponses: 0,
          deletedReports: 0,
          resetEmployees: 0
        });
      }

      const employeeIds = employees.map(e => e.employeesID);

      // Delete from Responses_Sentiment
      const [respResult] = await connection.execute(
        `DELETE FROM Responses_Sentiment WHERE employeesID IN (${employeeIds.map(() => '?').join(',')})`,
        employeeIds
      );

      // Delete from responses_langchain_sentiment
      const [langchainResult] = await connection.execute(
        `DELETE FROM responses_langchain_sentiment WHERE employeesID IN (${employeeIds.map(() => '?').join(',')})`,
        employeeIds
      );

      // Delete company report
      const [companyReportResult] = await connection.execute(
        'DELETE FROM company_reports_sentiment WHERE company_id = ?',
        [companyId]
      );

      // Reset is_filled flag for employees
      const [updateResult] = await connection.execute(
        `UPDATE employees SET is_filled = 0 WHERE employeesID IN (${employeeIds.map(() => '?').join(',')})`,
        employeeIds
      );

      // Commit transaction
      await connection.commit();

      return res.json({
        success: true,
        message: `Successfully reset data for ${employees.length} employee(s)`,
        deletedResponses: respResult.affectedRows,
        deletedLangchainReports: langchainResult.affectedRows,
        deletedCompanyReports: companyReportResult.affectedRows,
        resetEmployees: updateResult.affectedRows
      });

    } catch (err) {
      await connection.rollback();
      console.error('Error resetting company data:', err);
      return res.status(500).json({ success: false, message: 'Server error resetting company data' });
    } finally {
      connection.release();
    }
  });

  return router;
};
