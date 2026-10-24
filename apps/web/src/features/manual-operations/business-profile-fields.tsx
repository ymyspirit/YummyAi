"use client";

import { useState } from "react";
import type { SupplierProfile, BusinessAddress } from "@yummyai/contracts/suppliers/supplier-profile";
import { Field } from "./record-form";
import { formText } from "./operation-types";
import "./factory-directory.css";

export function AddressFields({ prefix, title, address, forActivation = false }: { prefix: string; title: string; address?: BusinessAddress | null; forActivation?: boolean }) {
  return <fieldset className="factory-form-section"><legend>{title}</legend><p className="record-help">{forActivation ? "草稿可留空或先填一部分；启用工厂前补齐国家、城市和详细地址。" : "选填，可留空或先填一部分，稍后补充。"}</p><div className="record-grid">
    <Field label={`${title}国家`}><input name={`${prefix}.countryCode`} maxLength={2} defaultValue={address?.countryCode ?? ""} placeholder="选填，CN / US" /></Field>
    <Field label={`${title}省／州`}><input name={`${prefix}.province`} maxLength={200} defaultValue={address?.province ?? ""} /></Field>
    <Field label={`${title}城市`}><input name={`${prefix}.city`} maxLength={200} defaultValue={address?.city ?? ""} /></Field>
    <Field label={`${title}区／县`}><input name={`${prefix}.district`} maxLength={200} defaultValue={address?.district ?? ""} /></Field>
  </div><Field label={`${title}详细地址`}><textarea name={`${prefix}.street`} maxLength={500} rows={2} defaultValue={address?.street ?? ""} /></Field><div className="record-grid">
    <Field label={`${title}邮编`}><input name={`${prefix}.postalCode`} maxLength={40} defaultValue={address?.postalCode ?? ""} /></Field>
    <Field label={`${title}收件人`}><input name={`${prefix}.recipient`} maxLength={200} defaultValue={address?.recipient ?? ""} /></Field>
    <Field label={`${title}收件电话`}><input name={`${prefix}.phone`} maxLength={80} defaultValue={address?.phone ?? ""} /></Field>
  </div></fieldset>;
}
export function addressFromForm(form: FormData, prefix: string): BusinessAddress | null {
  const read = (key: string) => formText(form, `${prefix}.${key}`);
  if (!["countryCode", "province", "city", "district", "street", "postalCode", "recipient", "phone"].some(key => read(key))) return null;
  return { countryCode: read("countryCode").toUpperCase(), province: read("province"), city: read("city"), district: read("district"), street: read("street"), postalCode: read("postalCode"), recipient: read("recipient"), phone: read("phone") };
}
const roles = { business: "商务", production: "生产跟单", quality: "质检", shipping: "收发货" } as const;
export function ContactFields({ prefix, contacts, defaultRole = "business", forActivation = false }: { prefix: string; contacts: SupplierProfile["contacts"]; defaultRole?: keyof typeof roles; forActivation?: boolean }) {
  const [rows, setRows] = useState(() => (contacts.length ? contacts : [{ name: "", role: defaultRole, phone: "", wechat: "", email: "" }]).map(contact => ({ ...contact, key: crypto.randomUUID() })));
  return <fieldset className="factory-form-section"><legend>联系人</legend><p className="record-help">{forActivation ? "草稿可留空或先填一部分；启用工厂前填写生产联系人姓名及至少一种联系方式。" : "选填，可先记录姓名或一种联系方式，稍后补充。"}</p>{rows.map((contact, index) => <div className="factory-contact-row" key={contact.key}>
    <input type="hidden" name={`${prefix}.indexes`} value={index} /><div className="record-grid">
      <Field label={`联系人 ${index + 1} 职责`}><select name={`${prefix}.${index}.role`} defaultValue={contact.role}>{Object.entries(roles).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></Field>
      <Field label={`联系人 ${index + 1} 姓名`}><input name={`${prefix}.${index}.name`} maxLength={200} defaultValue={contact.name} /></Field>
      <Field label={`联系人 ${index + 1} 电话`}><input name={`${prefix}.${index}.phone`} maxLength={80} defaultValue={contact.phone} /></Field>
      <Field label={`联系人 ${index + 1} 微信`}><input name={`${prefix}.${index}.wechat`} maxLength={200} defaultValue={contact.wechat} /></Field>
      <Field label={`联系人 ${index + 1} 邮箱`}><input type="email" name={`${prefix}.${index}.email`} maxLength={254} defaultValue={contact.email} /></Field>
    </div><button type="button" onClick={() => setRows(current => current.filter(row => row.key !== contact.key))}>移除联系人 {index + 1}</button>
  </div>)}<button type="button" disabled={rows.length >= 12} onClick={() => setRows(current => [...current, { name: "", role: defaultRole, phone: "", wechat: "", email: "", key: crypto.randomUUID() }])}>添加联系人</button></fieldset>;
}
export function contactsFromForm(form: FormData, prefix: string) {
  return form.getAll(`${prefix}.indexes`).map(index => {
    const read = (key: string) => formText(form, `${prefix}.${index}.${key}`);
    return { name: read("name"), role: read("role"), phone: read("phone"), wechat: read("wechat"), email: read("email") };
  }).filter(contact => !!(contact.name || contact.phone || contact.wechat || contact.email));
}
export function SupplierProfileFields({ profile }: { profile: SupplierProfile }) {
  return <><div className="record-grid"><Field label="所属主体性质"><select name="supplier.entityKind" defaultValue={profile.entityKind}><option value="unconfirmed">待确认</option><option value="external_supplier">外部供应商</option><option value="internal_entity">内部经营主体</option></select></Field>
    <Field label="企业全称"><input name="supplier.legalName" maxLength={200} defaultValue={profile.legalName} /></Field><Field label="简称"><input name="supplier.alias" maxLength={200} defaultValue={profile.alias} /></Field></div>
    <fieldset className="factory-form-section"><legend>业务角色</legend><div className="factory-checkboxes">{Object.entries({ manufacturing: "生产加工", blank_goods: "空白载体供货", raw_material: "原材料供货", packaging: "包装供货" }).map(([value, label]) => <label key={value}><input type="checkbox" name="supplier.roles" value={value} defaultChecked={profile.roles.some(role => role === value)} />{label}</label>)}</div></fieldset>
    <AddressFields prefix="supplier.officeAddress" title="办公地址" address={profile.officeAddress} /><ContactFields prefix="supplier.contacts" contacts={profile.contacts} />
    <Field label="付款与结算条件"><textarea name="supplier.paymentTerms" maxLength={2000} rows={3} defaultValue={profile.paymentTerms} placeholder="预付款、账期或内部成本核算约定" /></Field>
    <Field label="开票信息"><textarea name="supplier.invoiceInformation" maxLength={1000} rows={2} defaultValue={profile.invoiceInformation} /></Field>
    <Field label="合作备注"><textarea name="supplier.notes" maxLength={4000} rows={3} defaultValue={profile.notes} /></Field>
  </>;
}
export function supplierProfileFromForm(form: FormData) {
  return { schemaVersion: 1, entityKind: formText(form, "supplier.entityKind"), legalName: formText(form, "supplier.legalName"), alias: formText(form, "supplier.alias"), roles: form.getAll("supplier.roles"), contacts: contactsFromForm(form, "supplier.contacts"), officeAddress: addressFromForm(form, "supplier.officeAddress"), paymentTerms: formText(form, "supplier.paymentTerms"), invoiceInformation: formText(form, "supplier.invoiceInformation"), notes: formText(form, "supplier.notes") };
}
