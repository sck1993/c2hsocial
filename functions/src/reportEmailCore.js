"use strict";

const nodemailer = require("nodemailer");

let _transporter = null;

function getTransporter() {
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });
  }
  return _transporter;
}

async function dispatchEmail(mailOptions) {
  try {
    await getTransporter().sendMail(mailOptions);
  } catch (err) {
    console.error(`[reportEmailCore] 이메일 발송 실패 → ${mailOptions.to}:`, err.message);
    throw err;
  }
}

module.exports = {
  dispatchEmail,
};
