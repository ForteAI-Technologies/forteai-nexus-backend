const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const router = express.Router();
const { authenticateEmployee } = require('../middlewares/employee.auth');
const nodemailer = require('nodemailer');

module.exports = (pool) => {
  // Hardcode the table name
  const EMPLOYEES_TABLE = "employees";
  const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";
  const FRONTEND_URL = process.env.FRONTEND_URL 
  const BACKEND_URL = process.env.BACKEND_URL
  
  // Helper function to create JWT tokens
  const generateToken = (employee, expiresIn = "24h") => {
    return jwt.sign(
      { employeesID: employee.employeesID, role: employee.role },
      JWT_SECRET,
      { expiresIn }
    );
  };

  // Helper function to hash passwords
  const hashPassword = async (password) => {
    const saltRounds = 10;
    return await bcrypt.hash(password, saltRounds);
  };

  // Helper function to verify passwords
  const verifyPassword = async (plainPassword, storedPassword) => {
    if (!storedPassword) return false;
    
    if (storedPassword.startsWith("$2")) {
      // bcrypt hash
      return await bcrypt.compare(plainPassword, storedPassword);
    } else {
      // legacy plain text
      return plainPassword === storedPassword;
    }
  };

  // Email configuration and sending function - using Gmail App Password
  const sendEmail = async (to, subject, html) => {
    try {
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_APP_PASSWORD // App password instead of regular password
        }
      });

      const result = await transporter.sendMail({
        from: process.env.EMAIL_FROM || `"ForteAI Nexus" <${process.env.EMAIL_USER}>`,
        to,
        subject,
        html
      });

      console.log(`Email sent successfully to ${to}`);
      return result;
    } catch (error) {
      console.error('Error sending email:', error);
      throw error;
    }
  };

  // Helper function to create concise HTML email template
  const createCompactEmailTemplate = (title, content, buttonText, buttonLink) => {
    return `
      <!DOCTYPE html>
      <html>
      <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>${title}</title>
          <style>
              body { 
                  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
                  background-color: #f8f9fa; 
                  margin: 0; 
                  padding: 20px; 
                  color: #495057;
              }
              .email-container { 
                  max-width: 500px; 
                  margin: 0 auto; 
                  background: #ffffff; 
                  border-radius: 8px; 
                  overflow: hidden; 
                  box-shadow: 0 2px 8px rgba(0,0,0,0.08); 
                  border: 1px solid #e9ecef;
              }
              .header { 
                  background-color: #343a40; 
                  color: #ffffff; 
                  padding: 24px 20px; 
                  text-align: center; 
              }
              .header h1 { 
                  margin: 0; 
                  font-size: 20px; 
                  font-weight: 600; 
                  letter-spacing: 0.5px;
              }
              .main-content { 
                  padding: 32px 24px; 
              }
              .main-content h2 { 
                  color: #212529; 
                  margin: 0 0 20px 0; 
                  font-size: 18px; 
                  font-weight: 600;
              }
              .main-content p { 
                  color: #495057; 
                  line-height: 1.6; 
                  margin: 0 0 16px 0; 
                  font-size: 14px;
              }
              .cta-button { 
                  display: inline-block; 
                  background-color: #007bff; 
                  color: #ffffff !important; 
                  text-decoration: none; 
                  padding: 12px 24px; 
                  border-radius: 4px; 
                  font-weight: 600; 
                  font-size: 14px;
                  margin: 20px 0; 
                  border: none;
                  cursor: pointer;
              }
              .cta-button:hover {
                  background-color: #0056b3;
              }
              .highlight-box { 
                  background-color: #f8f9fa; 
                  border-left: 3px solid #007bff; 
                  border-radius: 4px; 
                  padding: 16px; 
                  margin: 20px 0; 
                  font-size: 13px;
              }
              .step-instructions {
                  background-color: #fff3cd;
                  border: 1px solid #ffeaa7;
                  border-radius: 4px;
                  padding: 16px;
                  margin: 20px 0;
                  font-size: 13px;
              }
              .step-instructions h3 {
                  color: #856404;
                  margin: 0 0 12px 0;
                  font-size: 14px;
                  font-weight: 600;
              }
              .step-list {
                  margin: 0;
                  padding-left: 18px;
                  color: #856404;
              }
              .step-list li {
                  margin-bottom: 4px;
              }
              .email-footer { 
                  background-color: #f8f9fa; 
                  padding: 20px 24px; 
                  text-align: center; 
                  color: #6c757d; 
                  font-size: 12px; 
                  border-top: 1px solid #e9ecef;
              }
              .email-footer p {
                  margin: 4px 0;
              }
              @media (max-width: 600px) {
                  .main-content { padding: 24px 20px; }
              }
          </style>
      </head>
      <body>
          <div class="email-container">
              <div class="header">
                  <h1>ForteAI Nexus</h1>
              </div>
              <div class="main-content">
                  ${content.replace(/class="info-box"/g, 'class="highlight-box"').replace(/class="instructions"/g, 'class="step-instructions"').replace(/<ol>/g, '<ol class="step-list">')}
                  ${buttonLink ? `
                  <div style="text-align: center; margin-top: 30px;">
                      <a href="${buttonLink}" class="cta-button" style="color: #ffffff !important;">${buttonText}</a>
                  </div>
                  ` : ''}
              </div>
              <div class="email-footer">
                  <p><strong>ForteAI Technologies Private Limited</strong></p>
                  <p>Developing AI-powered products for customers</p>
                  <p>This is an automated email. Please do not reply.</p>
              </div>
          </div>
      </body>
      </html>
    `;
  };

  // 1. LOGIN ENDPOINT
  router.post("/login", async (req, res) => {
    try {
      const { employeesID, password } = req.body;

      if (!employeesID || !password) {
        return res.status(400).json({
          success: false,
          message: "Employee ID and password are required",
        });
      }

      // Find the employee
      const [rows] = await pool.execute(
        `SELECT * FROM ${EMPLOYEES_TABLE} WHERE employeesID = ?`,
        [employeesID]
      );

      if (rows.length === 0) {
        return res.status(401).json({ 
          success: false, 
          message: "Invalid credentials" 
        });
      }

      const employee = rows[0];
      
      // Check if password is set (is_loggedin flag)
      if (!employee.is_loggedin) {
        return res.status(403).json({
          success: false,
          message: "You need to set your password first. Check your email or use 'Forgot Password'.",
          passwordNotSet: true
        });
      }

      // Verify password
      const passwordMatches = await verifyPassword(password, employee.password);
      if (!passwordMatches) {
        return res.status(401).json({ 
          success: false, 
          message: "Invalid credentials" 
        });
      }

      // Generate JWT token
      const token = generateToken(employee);

      // Remove password from response
      const { password: _, ...employeeWithoutPassword } = employee;

      console.log(`✅ Login successful for employee: ${employee.employeesID}`);
      console.log(`Agreement status (isagreed): ${employee.isagreed}`);
      console.log(`Role: ${employee.role}, Company: ${employee.company}`);

      res.json({
        success: true,
        employee: employeeWithoutPassword,
        token,
      });
    } catch (error) {
      console.error("Login error:", error);
      res.status(500).json({ 
        success: false, 
        message: "Server error during login" 
      });
    }
  });

  // 2. SET PASSWORD (for new users)
  router.post("/set-password", async (req, res) => {
    try {
      const { token, newPassword } = req.body;
      
      if (!token || !newPassword) {
        return res.status(400).json({ 
          success: false, 
          message: "Token and new password are required" 
        });
      }
      
      // Verify token
      let decoded;
      try {
        decoded = jwt.verify(token, JWT_SECRET);
      } catch (jwtError) {
        return res.status(400).json({ 
          success: false, 
          message: "Invalid or expired token" 
        });
      }
      
      const { employeesID } = decoded;
      
      // Find employee
      const [employees] = await pool.execute(
        `SELECT * FROM ${EMPLOYEES_TABLE} WHERE employeesID = ?`,
        [employeesID]
      );
      
      if (employees.length === 0) {
        return res.status(404).json({ 
          success: false, 
          message: "Employee not found" 
        });
      }
      
      // Hash the new password
      const hashedPassword = await hashPassword(newPassword);
      
      // Update the password and set is_loggedin to true
      await pool.execute(
        `UPDATE ${EMPLOYEES_TABLE} SET password = ?, is_loggedin = TRUE WHERE employeesID = ?`,
        [hashedPassword, employeesID]
      );
      
      // Generate a login token for immediate login
      const loginToken = generateToken(employees[0]);
      
      res.json({ 
        success: true, 
        message: "Password has been set successfully", 
        token: loginToken
      });
    } catch (error) {
      console.error('Set password error:', error);
      res.status(500).json({ 
        success: false, 
        message: "Server error during password setup" 
      });
    }
  });

  // 3. RESET PASSWORD API ENDPOINT
  router.post("/reset-password", async (req, res) => {
    try {
      const { token, newPassword } = req.body;
      
      if (!token || !newPassword) {
        return res.status(400).json({ 
          success: false, 
          message: "Token and new password are required" 
        });
      }
      
      // Verify token
      let decoded;
      try {
        decoded = jwt.verify(token, JWT_SECRET);
      } catch (jwtError) {
        return res.status(400).json({ 
          success: false, 
          message: "Invalid or expired token" 
        });
      }
      
      const { employeesID } = decoded;
      
      // Find employee
      const [employees] = await pool.execute(
        `SELECT * FROM ${EMPLOYEES_TABLE} WHERE employeesID = ?`,
        [employeesID]
      );
      
      if (employees.length === 0) {
        return res.status(404).json({ 
          success: false, 
          message: "Employee not found" 
        });
      }
      
      // Hash the new password
      const hashedPassword = await hashPassword(newPassword);
      
      // Update the password and set is_loggedin to true
      await pool.execute(
        `UPDATE ${EMPLOYEES_TABLE} SET password = ?, is_loggedin = TRUE WHERE employeesID = ?`,
        [hashedPassword, employeesID]
      );
      
      // Generate a login token for immediate login
      const loginToken = generateToken(employees[0]);
      
      res.json({ 
        success: true, 
        message: "Password has been reset successfully", 
        token: loginToken
      });
    } catch (error) {
      console.error('Reset password error:', error);
      res.status(500).json({ 
        success: false, 
        message: "Server error during password reset" 
      });
    }
  });

  // 4. FORGOT PASSWORD ENDPOINT - Updated with professional email and 10-minute expiry
  router.post("/forgot-password", async (req, res) => {
    try {
      const { employeesID, email } = req.body;
      
      if (!employeesID) {
        return res.status(400).json({ 
          success: false, 
          message: "Employee ID is required" 
        });
      }

      if (!email) {
        return res.status(400).json({ 
          success: false, 
          message: "Email address is required" 
        });
      }

      // First find employee by employeesID only
      const [employees] = await pool.execute(
        `SELECT employeesID, name, email FROM ${EMPLOYEES_TABLE} WHERE employeesID = ?`,
        [employeesID]
      );

      if (employees.length === 0) {
        // Employee doesn't exist
        return res.status(400).json({
          success: false,
          message: "Employee ID not found. Please check your Employee ID and try again."
        });
      }

      const employee = employees[0];
      
      // Check if employee has an email in database
      if (!employee.email) {
        return res.status(400).json({
          success: false,
          message: "This account doesn't have an email address. Please contact your HR department."
        });
      }

      // Check if the provided email matches the employee's registered email
      if (employee.email.toLowerCase() !== email.toLowerCase()) {
        return res.status(400).json({
          success: false,
          message: "The email address doesn't match our records for this Employee ID. Please enter the correct email address."
        });
      }
      
      // Create a reset token with 10-minute expiry
      const resetToken = jwt.sign(
        { employeesID: employee.employeesID },
        JWT_SECRET,
        { expiresIn: "10m" }
      );

      // Create reset URL pointing to our backend page
      const resetURL = `${BACKEND_URL}/api/reset-password-page?token=${resetToken}`;

      // Create professional email content for password reset
      const emailContent = `
        <h2>Password Reset Request</h2>
        <p>Dear <strong>${employee.name || employee.employeesID}</strong>,</p>
        <p>We have received a request to reset the password for your ForteAI Nexus account. For security purposes, your identity has been verified using your Employee ID and registered email address.</p>
        
        <div class="info-box">
            <strong>Account Information:</strong><br>
            Employee ID: ${employee.employeesID}<br>
            Email Address: ${employee.email}<br>
            Request Timestamp: ${new Date().toLocaleString()}<br>
            Link Expires: ${new Date(Date.now() + 10*60*1000).toLocaleString()}
        </div>
        
        <div class="instructions">
            <h3>📝 Password Reset Instructions:</h3>
            <ol>
                <li>Click the "Reset My Password" button below to access the secure reset page</li>
                <li>Create a new, strong password following the security requirements</li>
                <li>Confirm your new password by entering it again</li>
                <li>Click "Reset Password" to save your changes</li>
                <li>You will be automatically redirected to the ForteAI Nexus login page</li>
                <li>Log in using your Employee ID and new password</li>
            </ol>
        </div>
        
        <p><strong>🔐 Important Security Information:</strong></p>
        <p style="margin-bottom: 8px;">• This password reset link will expire in <strong>10 minutes</strong> for security purposes</p>
        <p style="margin-bottom: 8px;">• The link can only be used once</p>
        <p style="margin-bottom: 8px;">• If you did not request this password reset, please disregard this email</p>
        <p style="margin-bottom: 8px;">• For any security concerns, please contact your HR department immediately</p>
      `;

      // Send email with professional template
      await sendEmail(
        employee.email, 
        'ForteAI Nexus - Password Reset Request (Expires in 10 minutes)',
        createCompactEmailTemplate(
          'Password Reset Request',
          emailContent,
          'Reset My Password',
          resetURL
        )
      );
      
      res.json({ 
        success: true, 
        message: "Password reset instructions have been sent to your registered email address. Please check your inbox and complete the process within 10 minutes." 
      });
    } catch (error) {
      console.error('Forgot password error:', error);
      res.status(500).json({ 
        success: false, 
        message: "Server error during password reset request" 
      });
    }
  });

  // 5. CHANGE PASSWORD (for logged-in users)
  router.post("/change-password", authenticateEmployee, async (req, res) => {
    try {
      const { currentPassword, newPassword } = req.body;
      
      if (!currentPassword || !newPassword) {
        return res.status(400).json({ 
          success: false, 
          message: "Current password and new password are required" 
        });
      }

      const employeesID = req.employee.employeesID;
      
      // Get current password from database
      const [rows] = await pool.execute(
        `SELECT password FROM ${EMPLOYEES_TABLE} WHERE employeesID = ?`,
        [employeesID]
      );
      
      if (rows.length === 0) {
        return res.status(404).json({ 
          success: false, 
          message: "Employee not found" 
        });
      }
      
      const storedPassword = rows[0].password;
      
      // Verify current password
      const passwordMatches = await verifyPassword(currentPassword, storedPassword);
      if (!passwordMatches) {
        return res.status(401).json({ 
          success: false, 
          message: "Current password is incorrect" 
        });
      }
      
      // Hash and update the new password
      const hashedPassword = await hashPassword(newPassword);
      
      await pool.execute(
        `UPDATE ${EMPLOYEES_TABLE} SET password = ? WHERE employeesID = ?`,
        [hashedPassword, employeesID]
      );
      
      res.json({ 
        success: true, 
        message: "Password changed successfully" 
      });
    } catch (error) {
      console.error('Change password error:', error);
      res.status(500).json({ 
        success: false, 
        message: "Server error during password change" 
      });
    }
  });

  // 6. TEST AGREEMENT ENDPOINT (without auth)
  router.post("/test-agreement", async (req, res) => {
    console.log('🧪 Test agreement endpoint called');
    res.json({ success: true, message: "Test endpoint working" });
  });

  // 7. ACCEPT USER AGREEMENT
  router.post("/accept-agreement", authenticateEmployee, async (req, res) => {
    try {
      console.log('✅ Accept agreement endpoint called');
      console.log('Employee from token:', req.employee);
      console.log('Request body:', req.body);
      
      const employeesID = req.employee.employeesID;
      
      // Update the isagreed field to TRUE (BOOLEAN)
      console.log(`Updating isagreed for employee: ${employeesID}`);
      await pool.execute(
        `UPDATE ${EMPLOYEES_TABLE} SET isagreed = TRUE WHERE employeesID = ?`,
        [employeesID]
      );
      
      console.log('✅ Database update successful');
      
      res.json({ 
        success: true, 
        message: "User agreement accepted successfully" 
      });
    } catch (error) {
      console.error('Accept agreement error:', error);
      res.status(500).json({ 
        success: false, 
        message: "Server error during agreement acceptance" 
      });
    }
  });

  // 7. SEND INVITATION EMAIL - Updated with simplified content
  router.post("/send-invite", authenticateEmployee, async (req, res) => {
    try {
      const { employeesID } = req.body;
      
      if (!employeesID) {
        return res.status(400).json({ 
          success: false, 
          message: "Employee ID is required" 
        });
      }
      
      // Check if the requester has permission (HR or Admin)
      if (req.employee.role !== 'HR' && req.employee.role !== 'Admin') {
        return res.status(403).json({ 
          success: false, 
          message: "Only HR or Admin can send invitations" 
        });
      }
      
      // Find employee
      const [employees] = await pool.execute(
        `SELECT * FROM ${EMPLOYEES_TABLE} WHERE employeesID = ?`,
        [employeesID]
      );
      
      if (employees.length === 0) {
        return res.status(404).json({ 
          success: false, 
          message: "Employee not found" 
        });
      }
      
      const employee = employees[0];
      
      // Check if employee has an email
      if (!employee.email) {
        return res.status(400).json({ 
          success: false, 
          message: "Employee does not have an email address" 
        });
      }
      
      // Check if password is already set
      if (employee.is_loggedin) {
        return res.status(400).json({
          success: false,
          message: "Password is already set for this employee"
        });
      }
      
      // Create a token for setting initial password
      const setPasswordToken = jwt.sign(
        { employeesID: employee.employeesID },
        JWT_SECRET,
        { expiresIn: "7d" }
      );
      
      // Create set password URL pointing to our backend page
      const setPasswordURL = `${BACKEND_URL}/api/set-password-page?token=${setPasswordToken}`;
      
      // Create simplified welcome email content
      const welcomeContent = `
        <h2>Welcome to ForteAI Nexus</h2>
        <p>Dear <strong>${employee.name || employee.employeesID}</strong>,</p>
        <p>Your ForteAI Nexus account has been created and is ready for activation.</p>
        
        <div class="info-box">
            <strong>Account Details:</strong><br>
            Employee ID: ${employee.employeesID}<br>
            Company: ${employee.company || 'Not specified'}<br>
            Role: ${employee.role}<br>
            Link Valid Until: ${new Date(Date.now() + 7*24*60*60*1000).toLocaleDateString()}
        </div>
        
        <div class="instructions">
            <h3>🚀 Account Activation:</h3>
            <ol>
                <li>Click the "Set My Password" button below</li>
                <li>Create a secure password</li>
                <li>Confirm your password</li>
                <li>Click "Activate Account"</li>
                <li>You'll be redirected to the login page</li>
            </ol>
        </div>
        
        <p><strong>⏰ Important:</strong> This link expires in <strong>7 days</strong>.</p>
        <p>If you need assistance, contact your HR department.</p>
        
        <p>Best regards,<br><strong>ForteAI Nexus Team</strong></p>
      `;

      // Send simplified welcome email
      await sendEmail(
        employee.email,
        'Welcome to ForteAI Nexus - Activate Your Account',
        createCompactEmailTemplate(
          'Welcome to ForteAI Nexus',
          welcomeContent,
          'Set My Password',
          setPasswordURL
        )
      );
      
      res.json({ 
        success: true, 
        message: `Account activation email sent to ${employee.email}` 
      });
    } catch (error) {
      console.error('Send invitation error:', error);
      res.status(500).json({ 
        success: false, 
        message: "Server error during invitation" 
      });
    }
  });

  // 7. RESET PASSWORD PAGE (HTML) - Updated with minimal styling
  router.get("/reset-password-page", async (req, res) => {
    try {
      const { token } = req.query;
      
      if (!token) {
        return res.status(400).send(`
          <html>
            <head><title>Invalid Request - ForteAI Nexus</title></head>
            <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f8f9fa; margin: 0; padding: 20px; min-height: 100vh; display: flex; align-items: center; justify-content: center;">
              <div style="background: #ffffff; padding: 40px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); text-align: center; max-width: 400px; border: 1px solid #e9ecef;">
                <h1 style="color: #343a40; margin-bottom: 20px; font-size: 20px; font-weight: 600;">Invalid Request</h1>
                <p style="color: #6c757d; margin-bottom: 25px; line-height: 1.5;">No reset token provided. Please use the link from your password reset email.</p>
                <a href="${FRONTEND_URL || '#'}" style="background-color: #007bff; color: #ffffff; text-decoration: none; padding: 10px 20px; border-radius: 4px; display: inline-block; font-weight: 500; font-size: 14px;">Back to Login</a>
              </div>
            </body>
          </html>
        `);
      }
      
      // Verify token without throwing exception
      try {
        jwt.verify(token, JWT_SECRET);
      } catch (jwtError) {
        return res.status(400).send(`
          <html>
            <head><title>Token Expired - ForteAI Nexus</title></head>
            <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f8f9fa; margin: 0; padding: 20px; min-height: 100vh; display: flex; align-items: center; justify-content: center;">
              <div style="background: #ffffff; padding: 40px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); text-align: center; max-width: 450px; border: 1px solid #e9ecef;">
                <h1 style="color: #dc3545; margin-bottom: 20px; font-size: 20px; font-weight: 600;">🔒 Password Reset Link Expired</h1>
                <p style="color: #6c757d; margin-bottom: 25px; line-height: 1.5;">This password reset link has expired (valid for 10 minutes only). Please request a new password reset link.</p>
                <a href="${FRONTEND_URL || '#'}" style="background-color: #007bff; color: #ffffff; text-decoration: none; padding: 10px 20px; border-radius: 4px; display: inline-block; font-weight: 500; font-size: 14px;">Request New Reset Link</a>
              </div>
            </body>
          </html>
        `);
      }
      
      // If token is valid, serve the password reset form
      res.send(`
        <html>
          <head>
            <title>Reset Your Password - ForteAI Nexus</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
              body { 
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
                margin: 0; 
                padding: 20px; 
                background-color: #f8f9fa; 
                min-height: 100vh; 
                display: flex; 
                align-items: center; 
                justify-content: center; 
              }
              .container { 
                max-width: 400px; 
                background: #ffffff;
                border-radius: 8px; 
                padding: 40px; 
                box-shadow: 0 2px 8px rgba(0,0,0,0.08); 
                border: 1px solid #e9ecef;
                width: 100%;
              }
              .header {
                text-align: center;
                margin-bottom: 30px;
              }
              .header h1 { 
                font-size: 24px;
                font-weight: 600;
                color: #343a40;
                margin: 0 0 8px 0;
                letter-spacing: 0.5px;
              }
              .header p {
                color: #6c757d;
                margin: 0;
                font-weight: 400;
                font-size: 14px;
              }
              .security-notice {
                background-color: #fff3cd;
                border: 1px solid #ffeaa7;
                border-radius: 4px;
                padding: 12px;
                margin-bottom: 20px;
                font-size: 13px;
                color: #856404;
              }
              label { 
                display: block; 
                margin-bottom: 6px; 
                color: #495057;
                font-weight: 500;
                font-size: 14px;
              }
              input[type="password"] { 
                width: 100%; 
                padding: 12px; 
                margin-bottom: 16px; 
                border: 1px solid #ced4da; 
                border-radius: 4px; 
                box-sizing: border-box;
                font-size: 14px;
                background-color: #ffffff;
                transition: border-color 0.2s ease;
              }
              input[type="password"]:focus {
                outline: none;
                border-color: #007bff;
                box-shadow: 0 0 0 2px rgba(0, 123, 255, 0.1);
              }
              button { 
                width: 100%;
                background-color: #007bff; 
                color: #ffffff; 
                border: none; 
                padding: 12px 20px; 
                border-radius: 4px; 
                cursor: pointer; 
                font-size: 14px;
                font-weight: 500;
                transition: background-color 0.2s ease;
              }
              button:hover {
                background-color: #0056b3;
              }
              .error { 
                color: #dc3545; 
                background-color: #f8d7da;
                border: 1px solid #f5c6cb;
                padding: 12px;
                border-radius: 4px;
                margin-bottom: 16px; 
                display: none; 
                font-size: 13px;
              }
              .success { 
                color: #155724; 
                background-color: #d4edda;
                border: 1px solid #c3e6cb;
                padding: 12px;
                border-radius: 4px;
                margin-bottom: 16px; 
                display: none; 
                font-size: 13px;
              }
              .footer {
                text-align: center;
                margin-top: 24px;
                padding-top: 20px;
                border-top: 1px solid #e9ecef;
                color: #6c757d;
                font-size: 12px;
              }
              @media (max-width: 480px) {
                .container { padding: 30px 20px; margin: 0 10px; }
              }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="header">
                <h1>ForteAI Nexus</h1>
                <p>Secure Password Reset</p>
              </div>
              
              <div class="security-notice">
                <strong>⚠️ Security Notice:</strong> This password reset session will expire soon. Please complete the process promptly.
              </div>
              
              <div class="error" id="errorMsg"></div>
              <div class="success" id="successMsg"></div>
              
              <form id="resetForm">
                <input type="hidden" id="token" value="${token}">
                <div>
                  <label for="newPassword">New Password:</label>
                  <input type="password" id="newPassword" required placeholder="Create a strong password">
                </div>
                <div>
                  <label for="confirmPassword">Confirm New Password:</label>
                  <input type="password" id="confirmPassword" required placeholder="Confirm your new password">
                </div>
                <button type="submit">Reset Password</button>
              </form>
              
              <div class="footer">
                <p><strong>ForteAI Technologies Private Limited</strong></p>
                <p>Developing AI-powered products for customers</p>
              </div>
            </div>
            
            <script>
              document.getElementById('resetForm').addEventListener('submit', async function(e) {
                e.preventDefault();
                
                const errorEl = document.getElementById('errorMsg');
                const successEl = document.getElementById('successMsg');
                errorEl.style.display = 'none';
                successEl.style.display = 'none';
                
                const newPassword = document.getElementById('newPassword').value;
                const confirmPassword = document.getElementById('confirmPassword').value;
                const token = document.getElementById('token').value;
                
                if (newPassword !== confirmPassword) {
                  errorEl.textContent = 'Passwords do not match. Please ensure both password fields are identical.';
                  errorEl.style.display = 'block';
                  return;
                }
                
                if (newPassword.length < 8) {
                  errorEl.textContent = 'Password must be at least 8 characters long for security purposes.';
                  errorEl.style.display = 'block';
                  return;
                }
                
                try {
                  const response = await fetch('/api/reset-password', {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ token, newPassword }),
                  });
                  
                  const data = await response.json();
                  
                  if (data.success) {
                    successEl.textContent = '✅ Password has been reset successfully! Redirecting to login page...';
                    successEl.style.display = 'block';
                    document.getElementById('resetForm').style.display = 'none';
                    
                    setTimeout(() => {
                      window.location.href = '${FRONTEND_URL || '/login'}';
                    }, 2000);
                  } else {
                    errorEl.textContent = data.message || 'An error occurred during password reset. Please try again.';
                    errorEl.style.display = 'block';
                  }
                } catch (error) {
                  errorEl.textContent = 'Network connection error. Please check your internet connection and try again.';
                  errorEl.style.display = 'block';
                }
              });
            </script>
          </body>
        </html>
      `);
    } catch (error) {
      console.error('Reset password page error:', error);
      res.status(500).send(`
        <html>
          <head><title>Server Error - ForteAI Nexus</title></head>
          <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f8f9fa; margin: 0; padding: 20px; min-height: 100vh; display: flex; align-items: center; justify-content: center;">
            <div style="background: #ffffff; padding: 40px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); text-align: center; max-width: 400px; border: 1px solid #e9ecef;">
              <h1 style="color: #dc3545; font-size: 20px; margin-bottom: 20px; font-weight: 600;">System Error</h1>
              <p style="color: #6c757d; line-height: 1.5;">A system error occurred while processing your request. Please try again or contact technical support.</p>
            </div>
          </body>
        </html>
      `);
    }
  });

  // 8. SET PASSWORD PAGE (HTML) - Updated with minimal styling
  router.get("/set-password-page", async (req, res) => {
    try {
      const { token } = req.query;
      
      if (!token) {
        return res.status(400).send(`
          <html>
            <head><title>Invalid Request - ForteAI Nexus</title></head>
            <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f8f9fa; margin: 0; padding: 20px; min-height: 100vh; display: flex; align-items: center; justify-content: center;">
              <div style="background: #ffffff; padding: 40px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); text-align: center; max-width: 400px; border: 1px solid #e9ecef;">
                <h1 style="color: #343a40; margin-bottom: 20px; font-size: 20px; font-weight: 600;">Invalid Request</h1>
                <p style="color: #6c757d; margin-bottom: 25px; line-height: 1.5;">No setup token provided. Please use the link from your email.</p>
                <a href="${FRONTEND_URL || '#'}" style="background-color: #007bff; color: #ffffff; text-decoration: none; padding: 10px 20px; border-radius: 4px; display: inline-block; font-weight: 500; font-size: 14px;">Back to Login</a>
              </div>
            </body>
          </html>
        `);
      }
      
      // Verify token without throwing exception
      try {
        jwt.verify(token, JWT_SECRET);
      } catch (jwtError) {
        return res.status(400).send(`
          <html>
            <head><title>Invalid Token - ForteAI Nexus</title></head>
            <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f8f9fa; margin: 0; padding: 20px; min-height: 100vh; display: flex; align-items: center; justify-content: center;">
              <div style="background: #ffffff; padding: 40px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); text-align: center; max-width: 400px; border: 1px solid #e9ecef;">
                <h1 style="color: #dc3545; margin-bottom: 20px; font-size: 20px; font-weight: 600;">🔒 Link Expired</h1>
                <p style="color: #6c757d; margin-bottom: 25px; line-height: 1.5;">The setup link is invalid or has expired. Please contact your HR department for a new invitation.</p>
                <a href="${FRONTEND_URL || '#'}" style="background-color: #007bff; color: #ffffff; text-decoration: none; padding: 10px 20px; border-radius: 4px; display: inline-block; font-weight: 500; font-size: 14px;">Back to Login</a>
              </div>
            </body>
          </html>
        `);
      }
      
      // If token is valid, serve the password setup form
      res.send(`
        <html>
          <head>
            <title>Welcome to ForteAI Nexus - Set Your Password</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
              body { 
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
                margin: 0; 
                padding: 20px; 
                background-color: #f8f9fa; 
                min-height: 100vh; 
                display: flex; 
                align-items: center; 
                justify-content: center; 
              }
              .container { 
                max-width: 400px; 
                background: #ffffff;
                border-radius: 8px; 
                padding: 40px; 
                box-shadow: 0 2px 8px rgba(0,0,0,0.08); 
                border: 1px solid #e9ecef;
                width: 100%;
              }
              .header {
                text-align: center;
                margin-bottom: 30px;
              }
              .header h1 { 
                font-size: 24px;
                font-weight: 600;
                color: #343a40;
                margin: 0 0 8px 0;
                letter-spacing: 0.5px;
              }
              .header p {
                color: #6c757d;
                margin: 0;
                font-weight: 400;
                font-size: 14px;
              }
              .welcome-message {
                background-color: #007bff;
                color: #ffffff;
                padding: 16px;
                border-radius: 4px;
                margin-bottom: 20px;
                text-align: center;
                font-weight: 500;
                font-size: 14px;
              }
              label { 
                display: block; 
                margin-bottom: 6px; 
                color: #495057;
                font-weight: 500;
                font-size: 14px;
              }
              input[type="password"] { 
                width: 100%; 
                padding: 12px; 
                margin-bottom: 16px; 
                border: 1px solid #ced4da; 
                border-radius: 4px; 
                box-sizing: border-box;
                font-size: 14px;
                background-color: #ffffff;
                transition: border-color 0.2s ease;
              }
              input[type="password"]:focus {
                outline: none;
                border-color: #007bff;
                box-shadow: 0 0 0 2px rgba(0, 123, 255, 0.1);
              }
              button { 
                width: 100%;
                background-color: #007bff; 
                color: #ffffff; 
                border: none; 
                padding: 12px 20px; 
                border-radius: 4px; 
                cursor: pointer; 
                font-size: 14px;
                font-weight: 500;
                transition: background-color 0.2s ease;
              }
              button:hover {
                background-color: #0056b3;
              }
              .error { 
                color: #dc3545; 
                background-color: #f8d7da;
                border: 1px solid #f5c6cb;
                padding: 12px;
                border-radius: 4px;
                margin-bottom: 16px; 
                display: none; 
                font-size: 13px;
              }
              .success { 
                color: #155724; 
                background-color: #d4edda;
                border: 1px solid #c3e6cb;
                padding: 12px;
                border-radius: 4px;
                margin-bottom: 16px; 
                display: none; 
                font-size: 13px;
              }
              .footer {
                text-align: center;
                margin-top: 24px;
                padding-top: 20px;
                border-top: 1px solid #e9ecef;
                color: #6c757d;
                font-size: 12px;
              }
              @media (max-width: 480px) {
                .container { padding: 30px 20px; margin: 0 10px; }
              }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="header">
                <h1>ForteAI Nexus</h1>
                <p>Account Setup</p>
              </div>
              
              <div class="welcome-message">
                🎉 Welcome to ForteAI Nexus! Please set your password to get started.
              </div>
              
              <div class="error" id="errorMsg"></div>
              <div class="success" id="successMsg"></div>
              
              <form id="setupForm">
                <input type="hidden" id="token" value="${token}">
                <div>
                  <label for="newPassword">New Password:</label>
                  <input type="password" id="newPassword" required placeholder="Create a strong password">
                </div>
                <div>
                  <label for="confirmPassword">Confirm Password:</label>
                  <input type="password" id="confirmPassword" required placeholder="Confirm your password">
                </div>
                <button type="submit">Set Password & Activate Account</button>
              </form>
              
              <div class="footer">
                <p><strong>ForteAI Technologies Private Limited</strong></p>
                <p>Developing AI-powered products for customers</p>
              </div>
            </div>
            
            <script>
              document.getElementById('setupForm').addEventListener('submit', async function(e) {
                e.preventDefault();
                
                const errorEl = document.getElementById('errorMsg');
                const successEl = document.getElementById('successMsg');
                errorEl.style.display = 'none';
                successEl.style.display = 'none';
                
                const newPassword = document.getElementById('newPassword').value;
                const confirmPassword = document.getElementById('confirmPassword').value;
                const token = document.getElementById('token').value;
                
                if (newPassword !== confirmPassword) {
                  errorEl.textContent = 'Passwords do not match. Please try again.';
                  errorEl.style.display = 'block';
                  return;
                }
                
                if (newPassword.length < 6) {
                  errorEl.textContent = 'Password must be at least 6 characters long.';
                  errorEl.style.display = 'block';
                  return;
                }
                
                try {
                  const response = await fetch('/api/set-password', {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ token, newPassword }),
                  });
                  
                  const data = await response.json();
                  
                  if (data.success) {
                    successEl.textContent = '✅ Account activated successfully! Redirecting to login...';
                    successEl.style.display = 'block';
                    document.getElementById('setupForm').style.display = 'none';
                    
                    setTimeout(() => {
                      window.location.href = '${FRONTEND_URL || '/login'}';
                    }, 2000);
                  } else {
                    errorEl.textContent = data.message || 'An error occurred. Please try again.';
                    errorEl.style.display = 'block';
                  }
                } catch (error) {
                  errorEl.textContent = 'Network error. Please check your connection and try again.';
                  errorEl.style.display = 'block';
                }
              });
            </script>
          </body>
        </html>
      `);
    } catch (error) {
      console.error('Set password page error:', error);
      res.status(500).send(`
        <html>
          <head><title>Server Error - ForteAI Nexus</title></head>
          <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f8f9fa; margin: 0; padding: 20px; min-height: 100vh; display: flex; align-items: center; justify-content: center;">
            <div style="background: #ffffff; padding: 40px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); text-align: center; max-width: 400px; border: 1px solid #e9ecef;">
              <h1 style="color: #dc3545; font-size: 20px; margin-bottom: 20px; font-weight: 600;">Server Error</h1>
              <p style="color: #6c757d; line-height: 1.5;">An error occurred while processing your request. Please try again later.</p>
            </div>
          </body>
        </html>
      `);
    }
  });

  // 9. REQUEST PASSWORD RESET PAGE (HTML)
  router.get("/request-reset-page", async (req, res) => {
    res.send(`
      <html>
        <head>
          <title>Request Password Reset</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background-color: #f7f7f7; }
            .container { max-width: 500px; margin: 40px auto; padding: 20px; background-color: white; border-radius: 5px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            h1 { color: #333; }
            label { display: block; margin-bottom: 5px; }
            input[type="text"] { width: 100%; padding: 10px; margin-bottom: 20px; border: 1px solid #ddd; border-radius: 4px; }
            button { background-color: #4CAF50; color: white; border: none; padding: 10px 15px; border-radius: 4px; cursor: pointer; }
            .error { color: red; margin-bottom: 15px; display: none; }
            .success { color: green; margin-bottom: 15px; display: none; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Request Password Reset</h1>
            <p>Enter your Employee ID to receive a password reset link.</p>
            
            <div class="error" id="errorMsg"></div>
            <div class="success" id="successMsg"></div>
            
            <form id="requestForm">
              <div>
                <label for="employeesID">Employee ID:</label>
                <input type="text" id="employeesID" required>
              </div>
              <button type="submit">Request Reset Link</button>
            </form>
          </div>
          
          <script>
            document.getElementById('requestForm').addEventListener('submit', async function(e) {
              e.preventDefault();
              
              const errorEl = document.getElementById('errorMsg');
              const successEl = document.getElementById('successMsg');
              errorEl.style.display = 'none';
              successEl.style.display = 'none';
              
              const employeesID = document.getElementById('employeesID').value;
              
              try {
                const response = await fetch('/api/forgot-password', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({ employeesID }),
                });
                
                const data = await response.json();
                
                if (data.success) {
                  successEl.textContent = data.message;
                  successEl.style.display = 'block';
                  document.getElementById('requestForm').style.display = 'none';
                } else {
                  errorEl.textContent = data.message || 'An error occurred';
                  errorEl.style.display = 'block';
                }
              } catch (error) {
                errorEl.textContent = 'An error occurred. Please try again.';
                errorEl.style.display = 'block';
              }
            });
          </script>
        </body>
      </html>
    `);
  });

  return router;
};