// ==========================================
// PM2 PROCESS MANAGER -- SAMPLE CONFIG (Phase 15N)
//
// NOT active by default -- this is a template, not wired into the
// app. Only relevant if you are self-hosting on a VPS (not Render/
// Vercel, which manage the Node process for you already -- see the
// Phase 15 final report for which applies to your deployment).
//
// To use:
//   1. Copy this file to server/ecosystem.config.js (drop ".example")
//   2. Adjust `cwd` if this server doesn't live at /var/www/zioventure/server
//   3. npm install -g pm2
//   4. pm2 start ecosystem.config.js
//   5. pm2 save && pm2 startup   (makes PM2 itself survive a reboot)
//
// This file is deliberately NOT committed as ecosystem.config.js
// (only as this .example copy) so nothing here accidentally becomes
// "live" just by being present in the repo.
// ==========================================

module.exports = {
    apps: [
        {
            name: "zioventure-backend",
            script: "app.js",
            cwd: "/var/www/zioventure/server", // EDIT to your actual deploy path

            // Restart automatically on crash; cap restart frequency so a
            // crash-looping process doesn't spin the CPU forever.
            autorestart: true,
            max_restarts: 10,
            min_uptime: "30s",

            // Restart if memory usage grows unbounded (a safety net, not
            // a substitute for actually fixing a leak).
            max_memory_restart: "500M",

            // A single Node process handles this app today (Socket.IO's
            // in-memory onlineUsers Map assumes one process -- do NOT
            // set `instances` > 1 / cluster mode without first adding a
            // shared adapter, e.g. @socket.io/redis-adapter, and moving
            // onlineUsers out of process memory).
            instances: 1,
            exec_mode: "fork",

            env: {
                NODE_ENV: "production",
                // Real secrets belong in the server's own .env file
                // (loaded via dotenv, see server/app.js), NOT here --
                // this file is example/reference material that may end
                // up readable by more people than your .env should be.
            },

            // Log rotation: PM2 itself does not rotate logs by default.
            // Install the companion module once, on the server:
            //   pm2 install pm2-logrotate
            out_file: "/var/log/zioventure/backend-out.log",
            error_file: "/var/log/zioventure/backend-error.log",
            time: true,
        },
    ],
};
