# Product Requirements Document (PRD) - Exam Portal

## 1. Overview
The Exam Portal is a secure, scalable, and interactive web application designed to facilitate online examinations. It provides a robust platform for administrators to create, manage, and proctor exams, while offering students a seamless and secure environment to take their tests. The system includes live proctoring capabilities using WebRTC and webcam integration to ensure exam integrity.

## 2. Target Audience & User Personas
Based on the estimated user base, the system will support:
- **Students (Est. 1000 Users)**: End-users taking the exams. They need a simple, intuitive interface to view upcoming exams, take tests securely, and view their results.
- **Administrators/Teachers (Est. 10-20 Users)**: Users responsible for creating exams, managing question banks (including importing via PDF), monitoring students in real-time (live proctoring), and reviewing results.

## 3. Key Features & Functional Requirements

### 3.1 Authentication & Authorization (`AuthPortal`)
- **Role-based Access Control**: Separate login flows and access rights for Students and Admins.
- **Secure Authentication**: Integration with Firebase Authentication for secure sign-in.

### 3.2 Student Experience
- **Student Dashboard (`StudentDashboard`)**: 
  - View upcoming, active, and past exams.
  - Access performance reports and results.
- **Pre-Exam System Check (`PreExam`)**:
  - Mandatory hardware checks (Webcam, Microphone).
  - Network connectivity test.
  - Browser full-screen enforcement.
- **Exam Interface (`ExamNavbar`, `QuestionPanel`, `GridPanel`)**:
  - **Question Navigation**: Linear navigation (Next/Prev) and a grid view to jump to specific questions.
  - **Timer**: Real-time countdown timer displayed on the navbar.
  - **Offline Resilience (`OfflineOverlay`)**: Ability to detect network drops, pause the exam, and sync answers once the connection is restored.
- **Post-Exam (`Result`, `Terminated`)**:
  - Immediate result generation (if enabled by admin).
  - Auto-termination screen if cheating is suspected (e.g., exiting full-screen).

### 3.3 Admin Experience
- **Admin Dashboard (`AdminDashboard`)**:
  - Centralized hub for exam and user management.
- **Question Management (`QuestionEditor`, `pdfParser.js`)**:
  - Manual entry of questions (Multiple Choice, True/False, etc.).
  - Bulk import of questions using PDF parsing.
- **Live Proctoring (`LiveWebcam`, `WebRTCPlayer`)**:
  - Real-time video monitoring of students taking the exam using WebRTC.
  - Alerts for suspicious behavior (e.g., multiple faces detected, looking away).
- **Result & Analytics Management**:
  - View detailed reports on student performance.

## 4. Non-Functional Requirements

### 4.1 Security & Integrity
- **Anti-Cheating Mechanisms**:
  - Browser lockdown (Full-screen enforcement, preventing tab switching).
  - Copy-paste restrictions.
  - Live webcam proctoring.
- **Data Security**: Secure data transmission and storage using Firebase (Firestore/Realtime Database).

### 4.2 Scalability & Performance
- The system must comfortably handle concurrent sessions for up to **1000 students**.
- WebRTC video streams must be optimized to prevent server overload and ensure low latency for the 10-20 admins monitoring the streams.
- The frontend (React/Vite) must be highly responsive with minimal load times.

### 4.3 Availability & Reliability
- High availability (99.9% uptime) during exam periods.
- Graceful handling of temporary network disconnects without losing the student's progress.

## 5. Technology Stack
- **Frontend**: React.js, Vite (for fast builds and HMR)
- **Backend & Database**: Firebase (Auth, Firestore, Cloud Functions)
- **Proctoring**: WebRTC, standard HTML5 Media APIs for Webcam
- **Utilities**: PDF.js (for parsing PDFs), Recharts (for analytics/results)

## 6. Future Enhancements (Phase 2)
- AI-based automated proctoring (gaze tracking, face recognition).
- More complex question types (e.g., coding environments, essay grading).
- Integration with external Learning Management Systems (LMS) via LTI.
