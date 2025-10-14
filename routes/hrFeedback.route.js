const express = require('express');

// This module exports a function that takes a MySQL pool and returns a router
module.exports = (pool) => {
  const router = express.Router();

  // GET /questions - get all active HR feedback questions with options
  router.get('/questions', async (req, res) => {
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

  // GET /responses - check if current HR user has submitted feedback
  router.get('/responses', async (req, res) => {
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

  // POST /responses - submit HR feedback responses
  router.post('/responses', async (req, res) => {
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

  return router;
};
