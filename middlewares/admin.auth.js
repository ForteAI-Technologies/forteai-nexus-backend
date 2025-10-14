const jwt = require("jsonwebtoken");

const authenticateAdmin = (req, res, next) => {
  const token = req.headers["authorization"]?.split(" ")[1];
  if (!token) return res.status(401).json({ success: false, message: "Access token required" });

  jwt.verify(
    token,
    process.env.JWT_SECRET || "your-secret-key",
    (err, employee) => {
      if (err)
        return res.status(403).json({ success: false, message: "Invalid or expired token" });
      
      if (employee.role !== 'Admin') {
        return res.status(403).json({ success: false, message: "Admin access required" });
      }
      
      req.employee = employee;
      next();
    }
  );
};

module.exports = authenticateAdmin;
