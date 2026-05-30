# time-and-task-manager

A simple web app to track work hours and manage tasks — built for a small team.

## Demo

-> [Open Demo](https://abdi.silm.dev/demo/063A88368A69)

## The Story

At my internship, I needed a tool to track my work hours and keep notes on tasks. Instead of using an existing one, I just built my own. With the help of different AI tools, I was able to design, build, and deploy the whole app from scratch.

## What it does

- **Time tracking** — start/stop timer, manual entries, weekly and yearly overview
- **Task board** — Kanban board with drag & drop (Open / In Progress / Blocked / Done)
- **Archive** — completed tasks are saved and can never be deleted
- **Two roles** — Employee (full access) and Boss (read-only for time, can add tasks)


> Demo is read-only. You can view times and tasks but not make changes.

## Tech Stack

| Part | Technology |
|------|------------|
| Backend | Node.js + Express |
| Database | node:sqlite (built-in) |
| Frontend | Single HTML file, no framework |
| Server | Hetzner Ubuntu + Nginx + PM2 |
| SSL | Let's Encrypt |

## Run it locally

1. Clone the repo
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create a `.env` file:
   ```
   MITARBEITER_CODE=your_secret_code
   CHEF_CODE=your_other_secret_code
   ```
4. Start the server:
   ```bash
   node server.js
   ```
5. Open in browser:
   - Employee: `http://localhost:3000/mitarbeiter/your_secret_code`
   - Boss: `http://localhost:3000/chef/your_other_secret_code`

## Access

There is no login page. Access is done through secret URLs:

- Employee: `/mitarbeiter/{CODE}`
- Boss: `/chef/{CODE}`

Codes are stored in the `.env` file (not included in this repo).
