module.exports = {
  apps: [{
    name: 'nexus-backend',
    script: './server.js',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_restarts: 10,
    min_uptime: '10s',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    error_file: '/home/ec2-user/logs/nexus-backend-error.log',
    out_file: '/home/ec2-user/logs/nexus-backend-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    max_memory_restart: '1G',
    kill_timeout: 5000,
    listen_timeout: 3000,
    wait_ready: true
  }]
}
