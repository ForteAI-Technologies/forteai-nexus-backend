const jwt = require("jsonwebtoken");

// Basic authentication middleware for all employees
const authenticateEmployee = (req, res, next) => {
  const token = req.headers["authorization"]?.split(" ")[1];
  if (!token) return res.status(401).json({ success: false, message: "Access token required" });

  jwt.verify(
    token,
    process.env.JWT_SECRET || "your-secret-key",
    (err, employee) => {
      if (err)
        return res.status(403).json({ success: false, message: "Invalid or expired token" });
      
      req.employee = employee;
      next();
    }
  );
};

// Export as both an object and a direct function
module.exports = {
  authenticateEmployee
};
module.exports.authenticateEmployee = authenticateEmployee;
