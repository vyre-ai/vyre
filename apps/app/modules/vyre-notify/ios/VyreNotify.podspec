Pod::Spec.new do |s|
  s.name           = 'VyreNotify'
  s.version        = '0.0.1'
  s.summary        = 'Local notices on iOS made by the app itself'
  s.description    = 'UNUserNotificationCenter local notices; no APNs, no push token'
  s.author         = ''
  s.homepage       = 'https://vyre.sh'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'UserNotifications'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,swift}"
end
