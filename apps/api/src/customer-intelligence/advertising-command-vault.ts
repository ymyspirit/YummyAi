import {createEnvironmentSecretVault} from "@yummyai/ai-core";
/** Private originals use an encryption domain separate from models, PII and integrations. */
export function createAdvertisingCommandVault(environment:NodeJS.ProcessEnv=process.env){
  const configured=environment.ADVERTISING_COMMAND_ENCRYPTION_KEY?.trim();
  if(configured){
    const key=Buffer.from(configured,"base64url");
    for(const name of["FINANCE_COMMAND_ENCRYPTION_KEY","PROCUREMENT_COMMAND_ENCRYPTION_KEY","INCOMING_COMMAND_ENCRYPTION_KEY",
      "ORDER_PII_ENCRYPTION_KEY","MODEL_PROVIDER_ENCRYPTION_KEY","INTEGRATION_SECRET_ENCRYPTION_KEY"]){
      const other=environment[name]?.trim();
      if(other&&key.equals(Buffer.from(other,"base64url")))throw new TypeError("ADVERTISING_COMMAND_ENCRYPTION_KEY must be independent from other encryption domains");
    }
  }
  return createEnvironmentSecretVault("ADVERTISING_COMMAND_ENCRYPTION_KEY","yummyai:advertising-command:v1",environment);
}
