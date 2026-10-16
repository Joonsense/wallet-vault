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
wv balance trader1                # 8개 체인 네이티브 잔고 병렬 조회 (--chain base,sol / --json / --index N)
wv send trader1 --chain base --to 0x... --amount 0.01 --dry-run   # 수수료·잔고 미리보기만
wv send trader1 --chain sol --to <addr> --amount 0.1              # "send" 타이핑 확인 후 브로드캐스트
```

## 체인

| 키 | 체인 | 네이티브 | 기본 RPC |
| --- | --- | --- | --- |
| eth | Ethereum | ETH | viem 기본 공개 RPC |
| base | Base | ETH | mainnet.base.org |
| arb | Arbitrum One | ETH | arb1.arbitrum.io |
| op | OP Mainnet | ETH | mainnet.optimism.io |
| bnb | BNB Chain | BNB | viem 기본 공개 RPC |
| polygon | Polygon PoS | POL | viem 기본 공개 RPC |
| avax | Avalanche C | AVAX | api.avax.network |
| sol | Solana | SOL | api.mainnet-beta.solana.com |

테스트넷: `sepolia`, `base-sepolia`, `arb-sepolia`, `op-sepolia`, `bnb-testnet`, `amoy`, `fuji`, `sol-devnet`.
`--chain all` 은 메인넷만, `--chain testnets` 는 테스트넷만, `--chain everything` 은 둘 다. send 미리보기 첫 줄에 MAINNET / testnet 이 표시된다.

```bash
wv faucet test1 --chain sol-devnet --amount 1   # devnet 에어드롭 (공개 RPC 한도 초과 시 faucet.solana.com 안내)
wv faucet test1 --chain base-sepolia            # EVM 테스트넷은 주소 + 웹 faucet 주소 출력
wv send test1 --chain sol-devnet --to <addr> --amount 0.1
```

공개 RPC 는 속도 제한이 있으니 자주 쓰면 `WV_RPC_BASE=https://...` 처럼 체인별 RPC 를 .env 에 넣는다 (하이픈은 밑줄로, 예 `WV_RPC_SOL_DEVNET`). 별칭: ethereum, arbitrum, optimism, bsc, matic, solana.

### send 안전장치

- EVM 주소는 체크섬 불일치면 거부, Solana 주소는 base58 공개키 검증.
- 보내기 전 수수료(EVM maxFee × gas, SOL getFeeForMessage)·잔고 변화·경고를 보여주고, 잔고 부족이면 브로드캐스트 전에 중단.
- 수신자가 컨트랙트면 경고, Solana 새 계정이면 rent exempt 최소액 미만 경고.
- `--dry-run` 은 서명·전송 없이 미리보기만. `--yes` 없이는 "send" 를 타이핑해야 나간다.
- 네이티브 토큰만. ERC-20·SPL 토큰 전송은 없다.

## 지출 정책 + 원장

지갑마다 정책을 걸면 모든 send 가 그 안에서만 나간다. 에이전트(MCP)는 정책을 넘을 수 없고, 사람(CLI)은 `--override-policy` 를 주고 "override" 를 타이핑해야 넘을 수 있으며 원장에 OVERRIDE 로 남는다.

```bash
wv policy set bot --chain base,sol --per-tx 0.01 --per-day 0.05 --agent on --note "swan hot"
wv policy set bot --chain "*" --per-tx 0.001 --per-day 0.003     # 명시 안 된 체인의 기본 한도
wv policy allow bot 0xMyCold... 9RqexsMySolCold...                # 수신 허용목록 (비어 있으면 아무 주소나)
wv policy deny bot 0xMyCold...
wv policy show bot
wv policy clear bot
wv history bot                                                    # ~/.wallet-vault/ledger.jsonl (sent·failed·denied·pending)
```

| 규칙 | 내용 |
| --- | --- |
| 체인 | `chains` 에 없는 체인은 거부 |
| 수신자 | `allow` 가 비어 있지 않으면 목록에 없는 주소 거부 (EVM 은 대소문자 무시, Solana 는 정확 일치) |
| 건당 | `perTx` 초과 거부 (체인별, 없으면 `*`) |
| 일일 | 최근 24시간 원장의 sent + pending 합계 + 이번 금액이 `perDay` 초과면 거부. failed·denied 는 안 셈 |
| 정책 없음 | CLI 는 확인 후 허용, 에이전트는 거부 |
| 단위 | 체인의 네이티브 단위 (ETH, SOL ...). USD 환산 없음 |

송금 순서는 로컬 서명(해시 확정) → 원장 락 안에서 정책 재검사 + 해시 포함 pending 기록 → 브로드캐스트다. 전송 이후의 오류는 failed 가 아니라 unknown 으로 남아 한도에 계속 잡히고, `wv reconcile` 이 체인 상태(영수증·서명 상태)로 sent/failed 를 확정한다. 48시간 넘게 체인에 없으면 failed 로 정리한다.

### 무결성

정책과 원장은 평문 메타데이터라서 볼트 키에서 파생한 서브키로 서명한다.

| 대상 | 방식 | 깨지면 |
| --- | --- | --- |
| entry.policy | HMAC(id + chains + addresses + 암호문 + policy) 를 `policyMac` 에 저장, 비밀 암호문은 항목 id 를 AAD 로 묶음 (정책을 다른 지갑 항목에 옮겨 붙일 수 없음) | MCP 에서 지갑이 숨겨지고, CLI 는 경고 + 정책 거부 사유로 표시 |
| ledger.jsonl | 레코드마다 이전 MAC 에 체인된 HMAC, 머리(count·mac) 는 `ledger.head` 에 서명 저장. 볼트 생성 시 빈 원장 + genesis head 가 같이 생기므로 "원장이 없는 상태" 는 존재하지 않는다 | 파일이 없거나 잘리면 에이전트 send 거부, CLI 는 `--override-policy` 로만 진행 |
| vault.ledgerMeta | epoch 를 볼트 키로 서명한 표식. 없거나 틀리면 볼트가 열리지 않는다(fail closed) | 명시적 `wv ledger reset`(암호 필요, "reset" 타이핑) 만 새 epoch 를 만들고 옛 파일은 archived 로 보존 |
| 암호 교체 | 재암호화 전에 정책을 검증하고, 통과한 정책만 새 키로 재서명. 실패 정책은 폐기 보고. 원장 전체를 새 키로 재MAC | 원장 검증 실패 상태에서는 교체 거부 |
| 정책 편집 | 서명이 깨진 정책 위에는 set 불가(clear 후 재설정), 원장 검증 실패 중에도 불가. 항목의 키가 주소와 일치하는지 확인 후 서명 | |
| 락 | mkdir 원자 생성 + 소유자 토큰, 30초 지난 락은 rename 으로 한 프로세스만 탈취 | 10초 대기 후 "lock timeout" |

위협 모델을 정직하게 적으면: 이 장치는 MCP 도구 경계로 들어오는 에이전트의 실수·프롬프트 인젝션·"파일을 고쳐 한도를 풀기" 를 막는다. 같은 사용자 권한으로 임의 셸을 실행하는 에이전트가 키체인에서 암호를 직접 꺼내는 것, 또는 vault.json·ledger.jsonl·ledger.head 세 파일을 과거 시점으로 함께 되돌리는 롤백은 막지 못한다. 그 둘은 에이전트에 셸 권한을 주지 않는 것과 백업 보관으로 다뤄야 한다.

## MCP 서버

`wv mcp` 는 stdio MCP 서버다. 정책에 `--agent on` 인 지갑만 보이고, 비밀을 내보내는 도구는 없다.

| 도구 | 하는 일 |
| --- | --- |
| list_wallets | 에이전트 지갑의 주소·허용 체인·한도·허용목록 |
| get_policy | 정책 사람용 설명 |
| get_balance | 네이티브 잔고 (체인 목록, all, testnets) |
| spend_history | 최근 시도 (sent·failed·denied) |
| send_native | 정책 검사 → 미리보기(dry_run) 또는 브로드캐스트. 거부되면 사유와 함께 isError, 원장에 denied 기록 |

stdio 에는 프롬프트가 없으므로 암호는 `WV_PASSPHRASE` 또는 `WV_PASSPHRASE_CMD` 로 준다. macOS 는 키체인이 낫다.

```bash
security add-generic-password -s wallet-vault -a "$USER" -w       # 한 번, 암호 입력
```

Claude Code 등록 예 (`~/.claude.json` 또는 프로젝트 `.mcp.json`):

```json
{ "mcpServers": { "wallet-vault": {
  "command": "wv", "args": ["mcp"],
  "env": { "WV_PASSPHRASE_CMD": "security find-generic-password -s wallet-vault -a joons -w" } } } }
```

스모크 테스트: `WV_VAULT=... WV_PASSPHRASE=... node scripts/mcp-smoke.mjs <wallet> <to>`.

## Hyperliquid API 지갑 (agent wallet)

HL 봇은 메인 계정 키 대신 메인이 승인한 agent 키로 서명한다. agent 는 거래만 하고 출금은 못 한다.
wv 는 agent 키 생성 → 볼트 저장 → 메인 키로 approveAgent EIP-712 서명·제출을 한 명령으로 한다.

```bash
wv hl agents main --testnet                      # 승인된 agent 목록 + 만료, 볼트에 키가 있는지 표시
wv hl new-agent main --name swan --days 30       # 새 키 생성 + 승인 (메인넷, "approve" 타이핑 확인)
wv hl approve main --agent 7 --name swan         # 볼트의 기존 키 승인
eval "$(wv env hl-swan)"                         # 봇에는 agent 키만 주입, 계정 조회는 메인 주소로
```

규칙 (HL 문서 기준): 계정당 unnamed 1개 + named 3개, named 는 `--days` 로 최대 180일 만료 지정. 같은 이름으로 다시 승인하면 이전 agent 가 해제된다.
한 번 쓰고 해제된 agent 주소는 nonce 집합이 정리돼 재승인 시 과거 서명이 재생될 수 있으므로 재사용하지 않는다. `new-agent` 가 항상 새 키를 만드는 이유다.
승인이 거절돼도 agent 키는 볼트에 남고 note 에 사유가 기록된다 (예: 메인이 HL 에 입금한 적 없으면 "Must deposit before performing actions").

## 보관 방식

| 항목 | 값 |
| --- | --- |
| 볼트 위치 | `~/.wallet-vault/vault.json` (`WV_VAULT` 로 변경), 권한 600. 원장 `ledger.jsonl` (`WV_LEDGER`) |
| 키 파생 | scrypt N=2^17 r=8 p=1, 볼트당 salt 32바이트 |
| 암호화 | AES-256-GCM, 지갑 항목마다 별도 iv·tag |
| HL 서명 | @nktkas/hyperliquid ExchangeClient (viem 계정), 메인넷 api.hyperliquid.xyz / 테스트넷 api.hyperliquid-testnet.xyz |
| 암호 입력 | 숨김 프롬프트, `WV_PASSPHRASE` (.env 에만), 또는 `WV_PASSPHRASE_CMD` (키체인 조회 명령) |
| 파생 경로 | EVM `m/44'/60'/0'/0/i`, Solana `m/44'/501'/i'/0'` (MetaMask·Phantom 과 동일) |

주소 외의 비밀은 `export` 와 `env` 두 명령에서만 stdout 으로 나오고, 그때마다 stderr 에 경고가 붙는다.
볼트 파일과 암호를 같은 곳에 두지 말 것. 볼트 파일만 유출돼도 암호 없이는 열리지 않지만, 암호가 약하면 의미가 없다.

## 검증

```bash
pnpm test    # BIP-44 / SLIP-0010 공개 테스트 벡터 + 볼트 암복호화·암호 교체
```
