Pod::Spec.new do |s|
  s.name           = 'VyreSigner'
  s.version        = '0.0.1'
  s.summary        = 'The Vyre person session key in the Secure Enclave'
  s.description    = 'ES256 keys in the Secure Enclave for the Vyre app person session'
  s.author         = ''
  s.homepage       = 'https://vyre.sh'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Security', 'LocalAuthentication', 'DeviceCheck'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,swift}"
end
