// The action table: every supported `action`, the authority it requires, its
// pure input validator, and its handler. The router (../router.ts) runs the
// shared request pipeline, then looks the action up here.

import type { ActionDefinition } from '../types.ts';
import {
  validateCreateAdmin,
  validateCreateStudent,
  validateNothing,
  validateResetApplication,
  validateResetStudentPassword,
  validateScopedCleanup,
  validateUpdateAssignment,
} from '../validation.ts';
import { createAdmin } from './createAdmin.ts';
import { createStudent } from './createStudent.ts';
import { resetStudentPassword } from './resetStudentPassword.ts';
import { clearScopedData, previewReset, resetApplication } from './rootData.ts';
import { updateAssignment } from './updateAssignment.ts';

// Ties each validator's output type to its handler's input type, then widens it
// so heterogeneous actions share one table. The router only ever passes a
// definition's own validate() result to that definition's handle().
const defineAction = <Input>(definition: ActionDefinition<Input>): ActionDefinition<unknown> => definition;

export const ACTIONS: Readonly<Record<string, ActionDefinition<unknown>>> = Object.freeze({
  // Root-only account-governance and destructive actions.
  'create-admin': defineAction({ authority: 'root', validate: validateCreateAdmin, handle: createAdmin }),
  'preview-reset': defineAction({ authority: 'root', validate: validateNothing, handle: previewReset }),
  'reset-application': defineAction({ authority: 'root', validate: validateResetApplication, handle: resetApplication }),
  'clear-scoped-data': defineAction({
    authority: 'root',
    validateBeforeAuthority: true,
    validate: validateScopedCleanup,
    handle: clearScopedData,
  }),
  // Administrator (AAL2) student-management actions.
  'create': defineAction({ authority: 'admin', validate: validateCreateStudent, handle: createStudent }),
  'update-assignment': defineAction({ authority: 'admin', validate: validateUpdateAssignment, handle: updateAssignment }),
  'reset-student-password': defineAction({ authority: 'admin', validate: validateResetStudentPassword, handle: resetStudentPassword }),
});

/** Own-property lookup, so names such as 'constructor' are unsupported actions. */
export function findAction(action: string): ActionDefinition<unknown> | null {
  return Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : null;
}
