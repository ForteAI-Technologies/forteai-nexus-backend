const jwt = require("jsonwebtoken");
const authenticateAdmin = (req, res, next) => {
  console.log('🔥 ADMIN AUTH MIDDLEWARE HIT');
  console.log('🔥 Method:', req.method);
  console.log('🔥 Path:', req.path);
  
  if (req.method === 'OPTIONS') {
    return next();
  }
  
  const token = req.headers["authorization"]?.split(" ")[1];
  console.log('🔥 Token received:', token ? 'YES' : 'NO');
  
  if (!token) return res.status(401).json({ success: false, message: "Access token required" });
  
  jwt.verify(
    token,
    process.env.JWT_SECRET || "your-secret-key",
    (err, employee) => {
      if (err) {
        console.log('🔥 Token verification FAILED:', err.message);
        return res.status(403).json({ success: false, message: "Invalid or expired token" });
      }
      
      console.log('🔥 Token decoded successfully!');
      console.log('🔥 Employee ID:', employee.employeesID);
      console.log('🔥 Role in token:', employee.role);
      console.log('🔥 Full employee object:', JSON.stringify(employee));
      
      if (employee.role !== 'Admin' && employee.role !== 'HR') {
        console.log('🔥 ACCESS DENIED - Role is:', employee.role);
        return res.status(403).json({ success: false, message: "Admin or HR access required" });
      }
      
      console.log('🔥 ACCESS GRANTED - Proceeding to route handler');
      req.employee = employee;
      next();
    }
  );
};
module.exports = authenticateAdmin;
