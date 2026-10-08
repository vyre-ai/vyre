# Run inside the DocuSeal container by Vyre (bin/rails runner), once, at install. It does what the first-run page does, with no browser:
# an account, one user, the app's address and signing certificate, an API token, and the webhook to Vyre. It prints NAME=value lines Vyre reads.
password = SecureRandom.hex(16)
account = Account.create!(name: "Vyre", timezone: "UTC", locale: "en-US")
user = account.users.create!(first_name: "Vyre", last_name: "Space", email: ENV.fetch("VYRE_LOGIN_EMAIL"), password: password)
account.encrypted_configs.create!([
  { key: EncryptedConfig::APP_URL_KEY, value: ENV.fetch("APP_URL") },
  { key: EncryptedConfig::ESIGN_CERTS_KEY, value: GenerateCertificate.call.transform_values(&:to_pem) }
])
account.account_configs.create!(key: :fulltext_search, value: true) if SearchEntry.table_exists?
account.account_configs.create!(key: :allow_http, value: true)
token = AccessToken.create!(user: user)
WebhookUrl.create!(account: account, url: ENV.fetch("VYRE_HOOK_URL"), events: %w[submission.completed form.completed], secret: { "X-Vyre-Token" => ENV.fetch("VYRE_HOOK_TOKEN") })
puts "api_token=#{token.token}"
puts "login_password=#{password}"
