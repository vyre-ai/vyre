# Run inside the DocuSeal container by Vyre (bin/rails runner, the script on stdin), at install, and again at a reinstall over the data an earlier removal kept. It does what the first-run
# page does, with no browser: an account, one user, the app's address and signing certificate, an API token, and the webhook to Vyre. It prints NAME=value lines Vyre reads. Run twice
# it changes nothing that was already right: the account, the user, the certificate and the token stay; the password and the webhook (whose key Vyre makes anew each time) are set again.
password = SecureRandom.hex(16)
account = Account.first || Account.create!(name: "Vyre", timezone: "UTC", locale: "en-US")
email = ENV.fetch("VYRE_LOGIN_EMAIL")
user = account.users.find_by(email: email)
if user
  user.update!(password: password)
else
  user = account.users.create!(first_name: "Vyre", last_name: "Space", email: email, password: password)
end
url = account.encrypted_configs.find_or_initialize_by(key: EncryptedConfig::APP_URL_KEY)
url.value = ENV.fetch("APP_URL")
url.save!
unless account.encrypted_configs.exists?(key: EncryptedConfig::ESIGN_CERTS_KEY)
  account.encrypted_configs.create!(key: EncryptedConfig::ESIGN_CERTS_KEY, value: GenerateCertificate.call.transform_values(&:to_pem))
end
account.account_configs.find_or_create_by!(key: :fulltext_search) { |c| c.value = true } if SearchEntry.table_exists?
account.account_configs.find_or_create_by!(key: :allow_http) { |c| c.value = true }
token = AccessToken.find_by(user: user) || AccessToken.create!(user: user)
WebhookUrl.where(account: account).delete_all
WebhookUrl.create!(account: account, url: ENV.fetch("VYRE_HOOK_URL"), events: %w[submission.completed form.completed], secret: { "X-Vyre-Token" => ENV.fetch("VYRE_HOOK_TOKEN") })
puts "api_token=#{token.token}"
puts "login_password=#{password}"
