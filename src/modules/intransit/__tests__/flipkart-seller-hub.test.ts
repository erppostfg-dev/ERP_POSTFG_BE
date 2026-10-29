import { describe, expect, it } from 'vitest';
import { otpFromMail } from '../../email-intake/otp-mail';
import { OTP_PATTERN } from '../sources/flipkart-seller-hub';

/*
 * The Seller Hub robot's login code (user, 2026-10-28): Flipkart mails it to support@, which lands in the intake
 * mailbox, with the code in the subject.
 */

describe('Seller Hub OTP mail', () => {
  it('reads the code from the subject', () => {
    expect(otpFromMail('Flipkart Account - 482913 is your verification code for secure access', '', OTP_PATTERN)).toBe('482913');
  });

  it('falls back to the body', () => {
    const body = 'Hi,\n739205 is your verification code for secure access to your Flipkart account.\nTracking id 12345678';
    expect(otpFromMail('Your Flipkart account', body, OTP_PATTERN)).toBe('739205');
  });

  it('ignores other numbers in an unrelated mail', () => {
    expect(otpFromMail('Order 1234567890 shipped', 'Invoice 482913 attached', OTP_PATTERN)).toBeNull();
  });
});
