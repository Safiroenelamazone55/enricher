module.exports = {
  apps: [{
    name:   'enricher-backend',
    script: './server.js',
    env: {
      NODE_ENV:     'development',
      PORT:         '3001',
      GITHUB_TOKEN: process.env.GITHUB_TOKEN || '',
    },
    env_production: {
      NODE_ENV: 'production',
    },
  }],
};
