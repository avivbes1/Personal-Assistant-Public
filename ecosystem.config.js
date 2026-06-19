module.exports = {
  apps: [{
    name: 'besinsky-bot',
    script: 'src/index.js',
    cwd: '/home/ubuntu/besinsky-bot',
    max_memory_restart: '900M',   // restart if Chrome + Node exceeds this
    restart_delay: 10000,          // wait 10s between restarts
    min_uptime: 30000,             // must stay up 30s to count as stable
    max_restarts: 20,              // cap runaway restart loops
    env: {
      NODE_ENV: 'production',
    },
  }],
};
