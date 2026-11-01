// How penalties get paid. This one is manual: you send the money in PayPay yourself, then tick the
// penalty in the 罰金 tab (the wife is told, so she can check it arrived). A screenshot of the transfer
// can still be sent for review instead.
//
// A future provider (for example a bank transfer API) would export the same shape, with `auto: true`
// and a `pay(penalty)` that sends the money and resolves once the bank has accepted it.
import { L } from '../i18n.js';
export const manualPaypay = {
  id: 'manual-paypay',
  auto: false,
  get label() { return L('PayPayで手動送金（送ったら罰金タブでチェック）', 'Send it by hand in PayPay (then tick it in the Penalties tab)'); },
  howToPay: total => L(`PayPayで嫁に ¥${total.toLocaleString('ja-JP')} を送ったら、アプリの罰金タブでチェックを入れてください。`,
    `Send ¥${total.toLocaleString('ja-JP')} to your wife in PayPay, then tick it in the app's Penalties tab.`),
};

export const paymentProvider = manualPaypay;
