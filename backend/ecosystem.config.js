require('dotenv').config({ path: __dirname + '/.env' });

module.exports = {
  apps: [{
    name:   'enricher-backend',
    script: './server.js',
    cwd:    __dirname,
    env: {
      NODE_ENV:              process.env.NODE_ENV     || 'production',
      PORT:                  process.env.PORT         || '3001',
      DATABASE_URL:          process.env.DATABASE_URL || '',
      GOOGLE_CLIENT_ID:      process.env.GOOGLE_CLIENT_ID     || '',
      GOOGLE_CLIENT_SECRET:  process.env.GOOGLE_CLIENT_SECRET || '',
      SESSION_SECRET:        process.env.SESSION_SECRET       || '',
      ALLOWED_ORIGINS:       process.env.ALLOWED_ORIGINS      || '',
      ALLOWED_EMAILS:        process.env.ALLOWED_EMAILS        || '',
      GITHUB_TOKEN:          process.env.GITHUB_TOKEN          || '',
    },
  }],
};
