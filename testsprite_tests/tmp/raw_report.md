
# TestSprite AI Testing Report(MCP)

---

## 1️⃣ Document Metadata
- **Project Name:** Exam-portal
- **Date:** 2026-06-29
- **Prepared by:** TestSprite AI Team

---

## 2️⃣ Requirement Validation Summary

#### Test TC001 Student submits a completed exam
- **Test Code:** [TC001_Student_submits_a_completed_exam.py](./TC001_Student_submits_a_completed_exam.py)
- **Test Error:** TEST BLOCKED

The test could not be run — the student account credentials were rejected and the exam flow could not be reached.

Observations:
- The page displays the error message 'Invalid Student ID or Password.'
- The Student ID and Password fields were filled and the Login button was clicked, but authentication failed and no exam list or start-exam option appeared.
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/8253897d-5aed-4799-a832-4c8cc3bbd14d/443f3802-d41f-4fc0-98f1-709dd0665f76
- **Status:** BLOCKED
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC002 Student grants required permissions and begins the exam
- **Test Code:** [TC002_Student_grants_required_permissions_and_begins_the_exam.py](./TC002_Student_grants_required_permissions_and_begins_the_exam.py)
- **Test Error:** TEST BLOCKED

The test could not be run — the UI repeatedly logs the user out before an exam session can be started, preventing access to permission prompts and the exam list.

Observations:
- The login page remains displayed after multiple login attempts and many auto-closed alerts read: 'You have been logged out because your account was accessed from another device.'
- Student ID and Password fields are filled, but clicking 'Login' does not navigate to an exam list or session UI.
- Repeated auto-closed logout alerts occur immediately after login attempts, blocking progress to the steps that would request webcam or screen-sharing permissions.

- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/8253897d-5aed-4799-a832-4c8cc3bbd14d/eb7b5a47-a38f-4594-b58c-61f3a43a6756
- **Status:** BLOCKED
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC003 Student can submit the exam successfully
- **Test Code:** [TC003_Student_can_submit_the_exam_successfully.py](./TC003_Student_can_submit_the_exam_successfully.py)
- **Test Error:** TEST BLOCKED

The test could not be run — the student account could not be authenticated with the provided credentials.

Observations:
- The login page displayed the message 'Invalid Student ID or Password.' after submitting credentials.
- The page remained on the login screen and did not navigate to a student dashboard or exam listing after the attempt.
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/8253897d-5aed-4799-a832-4c8cc3bbd14d/f9671e7d-b4e1-439f-86a1-22d977b5af91
- **Status:** BLOCKED
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC004 Student logs in and reaches the student dashboard
- **Test Code:** [TC004_Student_logs_in_and_reaches_the_student_dashboard.py](./TC004_Student_logs_in_and_reaches_the_student_dashboard.py)
- **Test Error:** TEST FAILURE

The student could not sign in with the provided credentials and was not taken to the student dashboard.

Observations:
- The login page displayed a red error: 'Invalid Student ID or Password.'
- The page remained on the Student Login form (Student ID and Password fields visible and populated), so the dashboard was not displayed.
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/8253897d-5aed-4799-a832-4c8cc3bbd14d/d6231cc5-f637-48c9-aa78-776998a9e5bb
- **Status:** ❌ Failed
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC005 Administrator logs in and reaches the admin dashboard
- **Test Code:** [TC005_Administrator_logs_in_and_reaches_the_admin_dashboard.py](./TC005_Administrator_logs_in_and_reaches_the_admin_dashboard.py)
- **Test Error:** TEST FAILURE

Admin login did not succeed — the provided credentials were rejected and the admin dashboard was not reached.

Observations:
- The login page shows the error message 'Invalid Admin Email or Password.'
- The page remains on the admin login form with the Username and Password fields visible
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/8253897d-5aed-4799-a832-4c8cc3bbd14d/78010d53-a7e7-4ad1-813c-5287d5081e30
- **Status:** ❌ Failed
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC006 Student can log in and start an exam
- **Test Code:** [TC006_Student_can_log_in_and_start_an_exam.py](./TC006_Student_can_log_in_and_start_an_exam.py)
- **Test Error:** TEST FAILURE

The student login could not be completed — the provided credentials were rejected, preventing navigation to the student dashboard and the exam start flow.

Observations:
- The page shows the error message: "Invalid Student ID or Password.".
- After submitting Student ID 'N24H01A0317' and password 'student123', the UI remained on the login page and displayed the error alert.
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/8253897d-5aed-4799-a832-4c8cc3bbd14d/050321d1-b258-4e2e-abac-e07bc3031d55
- **Status:** ❌ Failed
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC007 Student starts an exam from the dashboard
- **Test Code:** [TC007_Student_starts_an_exam_from_the_dashboard.py](./TC007_Student_starts_an_exam_from_the_dashboard.py)
- **Test Error:** TEST FAILURE

Starting the exam did not work — the provided PIN was rejected and no exam UI appeared.

Observations:
- The dashboard shows an "Invalid PIN. Please check the code and try again (ensure your system clock is accurate)." error message.
- The PIN field contains '123456' and clicking "Begin Examination" did not navigate to an active exam session.
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/8253897d-5aed-4799-a832-4c8cc3bbd14d/3f28b764-5fca-4526-9bd0-6fba88720d8a
- **Status:** ❌ Failed
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC008 Student can grant monitoring permissions and continue the exam
- **Test Code:** [TC008_Student_can_grant_monitoring_permissions_and_continue_the_exam.py](./TC008_Student_can_grant_monitoring_permissions_and_continue_the_exam.py)
- **Test Error:** TEST BLOCKED

The test could not be run — the Student Login could not be completed and the exam start screen could not be reached due to repeated forced logouts/session collisions.

Observations:
- The Student Login form remained visible after multiple submit attempts and an Enter keypress; no navigation to an exam list or exam start occurred.
- Numerous 'You have been logged out because your account was accessed from another device.' alerts appeared repeatedly during the attempts.
- No camera permission or screen-sharing dialogs were triggered because the exam start was never reached.
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/8253897d-5aed-4799-a832-4c8cc3bbd14d/e8b06bc9-2678-4d1b-9bbe-38d90433f4a6
- **Status:** BLOCKED
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC009 Administrator can log in and view summary stats
- **Test Code:** [TC009_Administrator_can_log_in_and_view_summary_stats.py](./TC009_Administrator_can_log_in_and_view_summary_stats.py)
- **Test Error:** TEST FAILURE

Admin login did not succeed — the provided credentials were rejected and the dashboard was not displayed.

Observations:
- The page shows a red error banner: 'Invalid Admin Email or Password.'
- The login form with Username and Password fields and the 'Login' button remains visible (the app stayed on the login screen).
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/8253897d-5aed-4799-a832-4c8cc3bbd14d/c291da9f-cfb7-4643-ab00-9e603644eb78
- **Status:** ❌ Failed
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC010 Student can answer a question and move forward
- **Test Code:** [TC010_Student_can_answer_a_question_and_move_forward.py](./TC010_Student_can_answer_a_question_and_move_forward.py)
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/8253897d-5aed-4799-a832-4c8cc3bbd14d/a7a3a43d-7e9c-4781-9352-d274c30b9e38
- **Status:** ✅ Passed
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC011 Admin reviews summary statistics on the dashboard
- **Test Code:** [TC011_Admin_reviews_summary_statistics_on_the_dashboard.py](./TC011_Admin_reviews_summary_statistics_on_the_dashboard.py)
- **Test Error:** TEST FAILURE

Administrator access to the dashboard could not be verified because authentication failed.

Observations:
- A red error alert reading 'Invalid Admin Email or Password.' is visible above the login fields.
- The login form is still displayed with the Username field showing 'admin' and the password field filled (masked).
- No admin dashboard or summary statistics are visible; the page remains at http://localhost:5173/.

- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/8253897d-5aed-4799-a832-4c8cc3bbd14d/a9158c81-d2f4-4e46-885f-0367d6628c17
- **Status:** ❌ Failed
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC012 Student views available exams on the dashboard
- **Test Code:** [TC012_Student_views_available_exams_on_the_dashboard.py](./TC012_Student_views_available_exams_on_the_dashboard.py)
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/8253897d-5aed-4799-a832-4c8cc3bbd14d/8e466989-ce7a-4849-9675-d470f85e5ecf
- **Status:** ✅ Passed
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC013 Student can navigate back to review a previous question
- **Test Code:** [TC013_Student_can_navigate_back_to_review_a_previous_question.py](./TC013_Student_can_navigate_back_to_review_a_previous_question.py)
- **Test Error:** TEST BLOCKED

The test could not be run — login with the provided student credentials failed, so the exam interface could not be reached.

Observations:
- The page displayed the message 'Invalid Student ID or Password.'
- The Student ID field shows N24H01A0317 and the password field was filled (the 'Login' button was clicked), yet authentication failed.
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/8253897d-5aed-4799-a832-4c8cc3bbd14d/b61cd01b-2cf6-43e9-9c13-5870c583966b
- **Status:** BLOCKED
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC014 Student navigates between questions and marks one for review
- **Test Code:** [TC014_Student_navigates_between_questions_and_marks_one_for_review.py](./TC014_Student_navigates_between_questions_and_marks_one_for_review.py)
- **Test Error:** TEST BLOCKED

The student login could not be completed because the UI repeatedly logged the session out, preventing access to the exam dashboard.

Observations:
- The login form (Student ID and Password) remained visible after multiple submit attempts.
- Numerous 'You have been logged out because your account was accessed from another device.' alerts appeared and auto-closed during the session.
- No exam dashboard or 'Start Exam' control became accessible, so exam navigation and mark-for-review features could not be reached or verified.
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/8253897d-5aed-4799-a832-4c8cc3bbd14d/b48ded5a-94d6-4614-9376-221e421c5a34
- **Status:** BLOCKED
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC015 Student can mark a question for review
- **Test Code:** [TC015_Student_can_mark_a_question_for_review.py](./TC015_Student_can_mark_a_question_for_review.py)
- **Test Error:** TEST BLOCKED

The test could not be run — the exam portal is unreachable and the login flow cannot be completed.

Observations:
- The page displays "ERR_EMPTY_RESPONSE" with the message that localhost didn’t send any data and only a 'Reload' button is available.
- Two login attempts were made (Student ID N24H01A0317 / password student123) and both failed to reach the dashboard.
- Multiple 'You have been logged out because your account was accessed from another device.' alerts repeatedly appeared and were auto-closed, indicating unstable server/session behavior.
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/8253897d-5aed-4799-a832-4c8cc3bbd14d/6e31b53a-f653-40bb-8280-b697b9d1c697
- **Status:** BLOCKED
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC016 Student can jump to a question from the grid
- **Test Code:** [TC016_Student_can_jump_to_a_question_from_the_grid.py](./TC016_Student_can_jump_to_a_question_from_the_grid.py)
- **Test Error:** TEST BLOCKED

The test could not be run — the student account could not be authenticated using the provided credentials.

Observations:
- The login form remains displayed after three login attempts with Student ID 'N24H01A0317' and password 'student123'.
- Multiple auto-closed alerts were shown stating: 'You have been logged out because your account was accessed from another device.'
- No persistent on-page error message ('Invalid Student ID or Password.') was found to explain the failure; the UI stayed on the login form and the exam flow (start exam, open grid, jump to question) could not be reached.
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/8253897d-5aed-4799-a832-4c8cc3bbd14d/04e2d68f-bc16-461e-9b86-fa575b6691f7
- **Status:** BLOCKED
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC017 Student jumps directly to a question from the question grid
- **Test Code:** [TC017_Student_jumps_directly_to_a_question_from_the_question_grid.py](./TC017_Student_jumps_directly_to_a_question_from_the_question_grid.py)
- **Test Error:** TEST BLOCKED

The test could not be run — the UI prevents reaching the exam list because login is being repeatedly revoked by forced logout events.

Observations:
- Multiple auto-closed alerts were recorded with the message: 'You have been logged out because your account was accessed from another device.'
- The Student Login form remains visible after repeated submission attempts and no navigation to an exam list occurred.
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/8253897d-5aed-4799-a832-4c8cc3bbd14d/8aaf737c-7e15-45f8-a9ec-37c06d0347a8
- **Status:** BLOCKED
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC018 Student login rejects a wrong-role account
- **Test Code:** [TC018_Student_login_rejects_a_wrong_role_account.py](./TC018_Student_login_rejects_a_wrong_role_account.py)
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/8253897d-5aed-4799-a832-4c8cc3bbd14d/b78cb2d7-ad3d-42ea-a722-ce5b8748dbf9
- **Status:** ✅ Passed
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC019 Student stays within the exam at navigation boundaries
- **Test Code:** [TC019_Student_stays_within_the_exam_at_navigation_boundaries.py](./TC019_Student_stays_within_the_exam_at_navigation_boundaries.py)
- **Test Error:** TEST BLOCKED

The test could not be run — access to the exam dashboard was blocked by failed authentication.

Observations:
- After submitting the login form, the page displayed 'Invalid Student ID or Password.'
- The login form remains visible and no exam dashboard or exam list is accessible, so exam navigation steps cannot be performed.
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/8253897d-5aed-4799-a832-4c8cc3bbd14d/e372a73c-0ada-4151-8620-98a5f2f3dcfe
- **Status:** BLOCKED
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC020 Student login rejects invalid credentials
- **Test Code:** [TC020_Student_login_rejects_invalid_credentials.py](./TC020_Student_login_rejects_invalid_credentials.py)
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/8253897d-5aed-4799-a832-4c8cc3bbd14d/e2bef678-ea54-4f53-a402-0f3934388589
- **Status:** ✅ Passed
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC021 Student stays on the login screen after invalid credentials
- **Test Code:** [TC021_Student_stays_on_the_login_screen_after_invalid_credentials.py](./TC021_Student_stays_on_the_login_screen_after_invalid_credentials.py)
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/8253897d-5aed-4799-a832-4c8cc3bbd14d/3e290da3-3841-4eb0-a530-b1bf187b1bfa
- **Status:** ✅ Passed
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---


## 3️⃣ Coverage & Matching Metrics

- **23.81** of tests passed

| Requirement        | Total Tests | ✅ Passed | ❌ Failed  |
|--------------------|-------------|-----------|------------|
| ...                | ...         | ...       | ...        |
---


## 4️⃣ Key Gaps / Risks
{AI_GNERATED_KET_GAPS_AND_RISKS}
---