export const MAX_PAYLOAD_BYTES = 16384;

// Student sign-in identities use a reserved, non-routable domain so no mail can
// ever reach a third party. Keep in sync with src/components/AuthPortal.jsx.
export const STUDENT_EMAIL_DOMAIN = 'students.examforge.invalid';
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;
