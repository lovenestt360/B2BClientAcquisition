import { z } from "zod";
import { MIN_PASSWORD_LENGTH } from "./password";

export const emailChangeInput = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  currentPassword: z.string().min(1, "Enter your current password"),
});

export const passwordChangeInput = z.object({
  currentPassword: z.string().min(1, "Enter your current password"),
  newPassword: z.string().min(MIN_PASSWORD_LENGTH, `New password must be at least ${MIN_PASSWORD_LENGTH} characters`),
  confirmPassword: z.string(),
}).refine((input) => input.newPassword === input.confirmPassword, {
  message: "New passwords do not match",
  path: ["confirmPassword"],
});
