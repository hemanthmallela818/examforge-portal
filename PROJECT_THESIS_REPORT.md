# DESIGN AND IMPLEMENTATION OF AN ADVANCED BROWSER-LOCKED CLOUD EXAMINATION PORTAL WITH AI-ASSISTED INGESTION AND OFFLINE RESILIENCE

---

## ABSTRACT

The rapid evolution of remote education and online certification has created an urgent need for secure, scalable, and resilient online examination platforms. Conventional examination portals often suffer from three major shortcomings: reliance on manual question entry, vulnerability to academic dishonesty in remote settings, and fragility against intermittent network connectivity. 

This thesis presents the design and implementation of a state-of-the-art **Browser-Locked Online Examination Portal**. Built upon a modern serverless cloud architecture using **React 19**, **Vite**, and **Supabase Backend Services** (PostgreSQL, Authentication, and Row Level Security), the platform delivers a high-concurrency, low-latency testing environment designed to mirror high-stakes academic examinations (such as JEE and university assessments). 

Key innovations include an automated **AI-Assisted PDF Question Ingestion Workflow** leveraging Gemini generative language models to parse raw exam papers into structured Multiple-Choice (MCQ) and Numerical question banks; a **Browser-Locking and Integrity Enforcement Engine** that continuously monitors student window-focus states, blocks keyboard shortcuts, disables context menus, enforces full-screen execution, and terminates sessions upon violation; and an **Offline Resilience Engine** that provides a 3-minute network disruption grace period and auto-recovers active states (including jumbled question layouts and remaining timer duration). Performance analytics and automated grading are synthesized visually using graphical charts (`Recharts`). This thesis details the architectural framework, component-level implementation, database schemas, and security pipelines of the developed system.

---

## CHAPTER 1: INTRODUCTION

### 1.1 Background and Motivation
Remote assessment systems have become foundational to modern educational institutions, competitive testing bodies, and corporate training programs. However, administering high-stakes assessments over the internet introduces complex challenges regarding academic integrity, system scalability, and administrative overhead. Traditional online testing portals require instructors to manually input hundreds of questions, options, and mathematical expressions into database forms—a time-consuming and error-prone process. Furthermore, unmonitored testing environments allow candidates to access external resources, collaborate illicitly, or manipulate browser states.

### 1.2 Problem Statement
1. **Administrative Overhead in Exam Creation:** Digitizing legacy PDF question papers into structured computer-based testing (CBT) formats requires massive manual data entry.
2. **Academic Dishonesty in Remote Environments:** Without real-time browser state locking, keyboard blocking, and tab-switching surveillance, remote assessments lack credibility.
3. **Network Instability:** In developing regions or distributed home environments, transient network dropouts frequently lead to session termination, data loss, and unfair student penalization.

### 1.3 Objectives of the Project
- **Automated Ingestion:** Develop a generative AI-driven PDF parsing workflow that extracts structured question data (MCQ options, numerical answers, subject tags, and diagram flags) from raw examination papers.
- **Strict Proctoring Enforcement:** Implement a multi-layered security framework utilizing page visibility APIs, fullscreen locks, keydown interceptors, and right-click disablers to prevent cheating.
- **Fault-Tolerant Execution:** Design a resilient client-state architecture that periodically backs up student responses and timer durations to Supabase, tolerating network disconnection for a 3-minute grace period.
- **Comprehensive Analytics:** Provide instant, detailed result analytics, including subject-wise score distribution, accuracy metrics, and response speed analysis.

### 1.4 Scope of the System
The system is divided into two primary interfaces:
- **The Administrative Portal:** Equipped with automated AI question extraction loaders, manual question editors, exam scheduling archives, student database management, and transaction logging.
- **The Candidate Portal:** Featuring secure onboarding, pre-exam diagnostic checklists, an intuitive multi-subject testing interface, and automated instant grading.

---

## CHAPTER 2: TECHNOLOGY STACK & LITERATURE REVIEW

### 2.1 Frontend Ecosystem
- **React 19:** Utilized for building modular, high-performance user interfaces with concurrent rendering and functional hooks (`useState`, `useEffect`, `useCallback`, `useRef`).
- **Vite:** A next-generation frontend build tool providing ultra-fast Hot Module Replacement (HMR) and optimized ES-module bundling.
- **Vanilla CSS & Design System (`index.css`):** Implements modern UI/UX aesthetics including glassmorphism, dynamic gradients, responsive grid layouts, and accessible micro-animations.
- **Custom Popup & Toast Framework (`CustomPopupContainer.jsx`):** A custom built-in dialog and notification stack replacing default browser alert/confirm/prompt methods with Promise-based glassmorphic modals.

### 2.2 Serverless Cloud & Database Backend
- **Supabase PostgreSQL:** A scalable relational database used to store question banks, active test sessions, and student scores with Row Level Security (RLS).
- **Supabase Auth:** Provides secure authentication and Role-Based Access Control (RBAC), mapping admin credentials and student IDs to secure, email-like auth profiles.
- **PostgreSQL Database Triggers:** Automatically syncs auth accounts created in `auth.users` to public profiles and student tables with correct meta-data (name, class, section, etc.).

### 2.3 Browser Integrity & Proctoring Enforcement
- **Page Visibility & Fullscreen APIs:** Native HTML5 web APIs utilized to track window focus, tab-switching events, and screen resizing.
- **Event Interception Pipelines:** Custom React event listeners bound to keydown events (blocking F12, Ctrl+Shift+I, Alt+Tab, etc.) and context menus to prevent inspect element and copy-paste.

### 2.4 Document Parsing & Visualization
- **Gemini Multimodal LLM:** Processes complex examination questions, equations, chemical structures, and layout structures to output standardized CBT JSON files.
- **MathJax / MathRenderer:** Formats raw LaTeX strings dynamically within the browser, rendering complex math equations and symbols cleanly.
- **Recharts:** A composable charting library built on React components used to generate interactive data visualizations of student performance.

---

## CHAPTER 3: SYSTEM ARCHITECTURE & DATA FLOW

### 3.1 High-Level Architectural Topology
The application follows a cloud-native, relational client-server topology. The client browser hosts the single-page React application, which communicates asynchronously with Supabase. Real-time PostgreSQL row updates maintain synchronization between student exam timers and the database.

```text
+--------------------------------------------------------------------------------+
|                              CLIENT LAYER (React 19)                           |
|  +--------------------+  +-----------------------+  +-----------------------+  |
|  | Admin Dashboard    |  | Live Exam Engine      |  | AI Ingestion Loader   |  |
|  | (Class/Student Mgmt)|  | (Question/Grid Panel) |  | (JSON parsing)        |  |
|  +---------+----------+  +-----------+-----------+  +-----------+-----------+  |
+------------|-------------------------|--------------------------|--------------+
             |                         |                          |
             | RPC / Admin operations  | RLS Queries (JSON)       | Upload Ingested JSON
             v                         v                          v
+--------------------------------------------------------------------------------+
|                            CLOUD INFRASTRUCTURE (Supabase)                      |
|  +--------------------+  +-----------------------+  +-----------------------+  |
|  | Supabase Auth      |  | PostgreSQL DB (RLS)   |  | Triggers / RPCs       |  |
|  | (Sign In / Sign Up)|  | (exams, sessions, etc)|  | (handle_new_user, etc)|  |
|  +--------------------+  +-----------------------+  +-----------------------+  |
+--------------------------------------------------------------------------------+
```

### 3.2 Database Schema Design
The application utilizes PostgreSQL tables structured for rapid querying and minimal read/write latency:
1. **`profiles` Table:** Stores user identifiers, emails, and roles (`admin` or `student`).
2. **`classes` Table:** Stores class names and sections arrays.
3. **`students` Table:** Stores student meta-data (student_id, name, class, section) linked via UUID foreign key to `auth.users` on cascade delete.
4. **`cbt_exams` Table:** Encapsulates examination metadata including exam title, status, marking scheme, and structured question arrays across subjects.
5. **`active_sessions` Table:** Persists active test states including student answers, jumbled subject questions, and remaining timer duration (`time_left`).
6. **`student_results` Table:** Records completed submissions, overall scores, and correct/incorrect/unattempted metrics.

### 3.3 Security, Multi-Factor Authentication & Anti-Cheat Pipeline
The platform implements defense-in-depth across the client and PostgreSQL database layer:
1. **Mandatory Administrator MFA (AAL2):** Administrative access requires Time-based One-Time Passwords (TOTP) meeting Authenticator Assurance Level 2 (AAL2). All administrative RLS policies and Edge Functions enforce `auth.jwt() ->> 'aal' = 'aal2'`.
2. **Single Active Device Binding:** Candidate authentication invokes `claim_student_session` RPC, issuing a cryptographic session token. Stale devices attempting simultaneous requests are immediately terminated while preserving local offline work.
3. **Server-Owned Answer Separation & Grading:** Clean question papers are served to students without answer keys. Grading is computed strictly server-side inside PostgreSQL functions (`submit_exam`), with idempotent result creation preventing double-submissions.
4. **Active Surveillance:** Event listeners monitor `visibilitychange`, `blur`, context menus, and developer tool shortcuts. If a candidate leaves fullscreen or switches windows, violation counters increment and invoke server-enforced termination upon rule breach.

---

## CHAPTER 4: DETAILED MODULE DESIGN & IMPLEMENTATION

### 4.1 Authentication & Role-Based Access Control (`AuthPortal.jsx` & `AdminMfaModal.jsx`)
The authentication gateway handles role routing, credential verification, and MFA factor enrollment. Students authenticate via institutional ID tokens mapped to `auth.users`, followed by session claiming. Administrators must complete TOTP factor verification before gaining dashboard authorization.

### 4.2 AI Ingestion, Preflight Validation & Image Security (`AIQuestionImporter.jsx`, `QuestionEditor.jsx`)
A cornerstone feature of this platform is the automated ingestion of examination questions:
- **AI Extraction:** Prompts specify LaTeX math formatting, image reference flags, and structured JSON.
- **Deep Preflight Validation:** Exam paper activation runs server-side preflight integrity checks: verifying question completeness, four unique MCQ options, valid answer types, and physical cloud storage presence of all referenced diagrams.
- **Image Decompression-Bomb & Magic-Byte Protection:** Client and storage layers verify true MIME magic bytes (PNG, JPEG, WebP) and enforce pixel dimension bounds ($< 8192\times 8192$px) to prevent denial-of-service memory exhaustion.

### 4.3 Student Portal & Pre-Exam Diagnostic (`StudentDashboard.jsx` & `PreExam.jsx`)
Before accessing questions, candidates review test details and instructions. Only when they acknowledge instructions and the admin activates the exam status is the "Start Examination" button unlocked, ensuring synchronized testing schedules.

### 4.4 Live Examination Engine & Accessibility (`QuestionPanel.jsx`, `GridPanel.jsx`, `ExamNavbar.jsx`)
The core testing experience is designed to simulate national-level entrance examinations:
- **`ExamNavbar.jsx`:** Displays the real-time countdown timer derived from server deadlines, candidate profile, active subject switcher, and submission controls.
- **`QuestionPanel.jsx`:** Renders the active question text, formatting LaTeX equations dynamically.
- **`GridPanel.jsx`:** Accessible question palette providing keyboard navigation, WCAG high-contrast mode support, and status glyphs that do not depend solely on color.
- **`LiveAnnouncer.js`:** Screen-reader ARIA live region bridge communicating timer milestones (15m, 5m, 1m), autosave confirmations, and network status transitions.

### 4.5 Network Resilience & Offline Recovery Engine (`examLogic.js`, `OfflineOverlay.jsx`)
To address internet instability, global online/offline event listeners are bound:
- **Offline Overlay:** Connection loss triggers an immediate visual countdown with a 3-minute grace window, derived from the server deadline.
- **Versioned Recovery Snapshot:** Responses are preserved in `localStorage` under isolated schema keys (`cbt_recovery_v1_<student>_<examId>`).
- **Strict Reconciliation:** When connectivity returns, local responses overlay server state only if both share the exact base version, preventing stale browser data from overwriting newer confirmed progress.

### 4.6 Operations, Continuous Integration & Staging Rehearsal
- **Continuous Integration (`.github/workflows/ci.yml`):** Automated pipeline enforcing linting, unit/contract test execution, production Vite bundling, and dependency audit on every push.
- **Operational Health CLI (`scripts/operational-health-check.mjs`):** Admin tool verifying table integrity, publication subscriptions, and unreferenced asset cleanup.
- **High-Concurrency Staging Harness (`scripts/rehearse-staging.mjs`):** Simulates 80 concurrent students across sign-in, Realtime channels, exam execution, autosave, and submission with exponential backoff.

---

## CHAPTER 5: CONCLUSION & FUTURE WORK

### 5.1 Summary of Contributions
This thesis presented the successful design, architecture, and deployment of an advanced cloud-based examination portal. By uniting React 19 frontend responsiveness with Supabase Backend Services, the project resolves major pain points in remote assessments. The integration of Gemini AI workflows eliminates tedious manual question entry, while browser-locking anti-cheat mechanisms protect test integrity. Finally, the 3-minute offline grace period and active session recovery introduce essential real-world fault tolerance.

### 5.2 Future Enhancements
1. **Lightweight AI Proctoring Model:** Integrating client-side object detection models directly in the browser to flag secondary faces or mobile phones.
2. **Automated Diagram Extraction:** Enhancing the AI parser to crop and extract bounding-box diagrams from PDFs and upload them to cloud storage.
3. **Adaptive Difficulty Scaling:** Implementing dynamic question routing based on real-time candidate accuracy.

---

## APPENDIX: CODEBASE FILE STRUCTURE REFERENCE

```text
MockTest-main/
├── supabase/
│   └── migrations/
│       └── 20260823000000_schema.sql  # Database tables, triggers, and RLS policies
├── src/
│   ├── App.jsx                        # Main state machine, routing, and timer logic
│   ├── supabase.js                    # Supabase client configuration
│   ├── index.css                      # Vanilla CSS design system
│   ├── mockData.js                    # Fallback question banks and mock students
│   ├── utils.js                       # Custom dialog and toast Promise utilities
│   ├── components/
│   │   ├── AdminDashboard.jsx         # Administrative panels and database viewer
│   │   ├── AIQuestionImporter.jsx     # AI question JSON ingestion and history
│   │   ├── AuthPortal.jsx             # Role-based login via Supabase Auth
│   │   ├── CustomPopupContainer.jsx   # Promise-based popup dialog container
│   │   ├── ExamNavbar.jsx             # Candidate navigation bar and timer display
│   │   ├── ExamQuestionsArchive.jsx    # Repository of stored examinations
│   │   ├── GridPanel.jsx              # Color-coded interactive question grid
│   │   ├── MathRenderer.jsx           # LaTeX math expression formatter
│   │   ├── OfflineOverlay.jsx         # Connection loss 3-minute grace handler
│   │   ├── PreExam.jsx                # Candidate instructions and status synchronizer
│   │   ├── QuestionEditor.jsx         # Question authoring panel
│   │   ├── QuestionPanel.jsx          # MCQ and Numerical input panels
│   │   ├── Result.jsx                 # Scoring scorecard with Recharts visualization
│   │   ├── StudentDashboard.jsx       # Student dashboard and session recovery triggers
│   │   └── Terminated.jsx             # Security violation penalty screen
```
