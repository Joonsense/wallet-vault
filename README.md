# wallet-vault (`wv`)

메인넷 개인 지갑을 몇 초 만에 만들고, 개인키·니모닉을 로컬 암호화 볼트에 보관하는 CLI.
EVM(이더리움·Base·Arbitrum·BNB 등 전부 같은 키) + Solana 를 니모닉 하나로 파생한다.

## 설치

```bash
pnpm install
ln -sf "$PWD/src/cli.mjs" ~/.local/bin/wv   # 전역 명령
```

## 사용

```bash
wv new trader1                    # 24단어 니모닉 → EVM + Solana 주소, 볼트에 암호화 저장
wv new --chain evm --count 3 bot  # EVM 전용 3개 (bot-1, bot-2, bot-3)
wv list                           # 주소만 표시, 비밀은 절대 안 나옴
wv show trader1 --index 1         # 같은 니모닉의 1번 계정 주소
wv export trader1 --mnemonic      # 니모닉 오프라인 백업용 (reveal 타이핑 확인)
wv export trader1 --evm           # EVM 개인키
wv export trader1 --sol           # Solana 비밀키 (Phantom 가져오기 형식, base58 64바이트)
eval "$(wv env trader1)"          # 현재 셸에 EVM_PRIVATE_KEY / SOL_SECRET_KEY 주입 (봇 실행용)
wv import cold --mnemonic         # 기존 니모닉 가져오기 (숨김 프롬프트로 입력, 인자로 넘기면 거부)
wv import hot --evm               # 원시 개인키 가져오기 (--sol 은 base58 또는 JSON 배열)
wv rm trader1                     # 라벨 타이핑 확인 후 삭제
wv passwd                         # 볼트 암호 교체 (항상 프롬프트, WV_PASSPHRASE 무시, 같은 암호 거부)
wv backup ~/Backups/vault.json    # 암호화된 상태로 복사
```

## 보관 방식

| 항목 | 값 |
| --- | --- |
| 볼트 위치 | `~/.wallet-vault/vault.json` (`WV_VAULT` 로 변경), 권한 600 |
| 키 파생 | scrypt N=2^17 r=8 p=1, 볼트당 salt 32바이트 |
| 암호화 | AES-256-GCM, 지갑 항목마다 별도 iv·tag |
| 암호 입력 | 숨김 프롬프트, 또는 `WV_PASSPHRASE` 환경변수 (.env 에만, 커밋 금지) |
| 파생 경로 | EVM `m/44'/60'/0'/0/i`, Solana `m/44'/501'/i'/0'` (MetaMask·Phantom 과 동일) |

주소 외의 비밀은 `export` 와 `env` 두 명령에서만 stdout 으로 나오고, 그때마다 stderr 에 경고가 붙는다.
볼트 파일과 암호를 같은 곳에 두지 말 것. 볼트 파일만 유출돼도 암호 없이는 열리지 않지만, 암호가 약하면 의미가 없다.

## 검증

```bash
pnpm test    # BIP-44 / SLIP-0010 공개 테스트 벡터 + 볼트 암복호화·암호 교체
```
