// A Keychain item whose access control names one program: does another program's read raise the system prompt, and does the named
// program read it with none? Two builds of this file stand for "vyre" and "another binary". Legacy file-keychain API, because the
// access list (trusted applications) is what reviewer-2 asked about.
//   kc make <keychain>   create the item, trusting only this program
//   kc read <keychain>   read it with user interaction turned OFF, so a prompt shows up as errSecInteractionNotAllowed
import Foundation
import Security

let args = CommandLine.arguments
guard args.count >= 3 else { print("usage: kc make|read <keychain>"); exit(2) }
var kc: SecKeychain?
SecKeychainOpen(args[2], &kc)
let svc = "vyre-probe", acct = "key", secret = "secret-value"
switch args[1] {
case "make":
    var me: SecTrustedApplication?
    SecTrustedApplicationCreateFromPath(nil, &me)
    var access: SecAccess?
    let a = SecAccessCreate("vyre-probe" as CFString, [me!] as CFArray, &access)
    if a != 0 { print("ERR access \(a)"); exit(1) }
    var item: SecKeychainItem?
    let st = SecKeychainAddGenericPassword(kc, UInt32(svc.utf8.count), svc, UInt32(acct.utf8.count), acct, UInt32(secret.utf8.count), secret, &item)
    if st != 0 { print("ERR add \(st)"); exit(1) }
    let s2 = SecKeychainItemSetAccess(item!, access!)
    print(s2 == 0 ? "MADE" : "ERR setaccess \(s2)")
case "read":
    SecKeychainSetUserInteractionAllowed(false)
    var len: UInt32 = 0
    var data: UnsafeMutableRawPointer?
    let st = SecKeychainFindGenericPassword(kc, UInt32(svc.utf8.count), svc, UInt32(acct.utf8.count), acct, &len, &data, nil)
    if st == 0, let d = data { print("READ \(String(decoding: Data(bytes: d, count: Int(len)), as: UTF8.self))") } else { print("DENIED \(st)") }
default: print("usage"); exit(2)
}
