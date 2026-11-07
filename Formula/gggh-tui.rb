class GgghTui < Formula
  desc "Terminal app for GGGH: monitor and control your cloud gaming machines"
  homepage "https://github.com/reganireland-source/cloudgaming/tree/main/tui"
  url "https://github.com/reganireland-source/cloudgaming/archive/d1c3899e804b11118db06f4adb4149da115e3dc8.tar.gz"
  version "0.5.1"
  sha256 "13a52a8be6fc96d25ee1006093b7c348639ea85d44aba967ef6db790f0fd8b65"
  head "https://github.com/reganireland-source/cloudgaming.git", branch: "main"

  depends_on "go" => :build

  def install
    cd "tui" do
      system "go", "build", *std_go_args(ldflags: "-s -w -X main.version=#{version}")
    end
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/gggh-tui --version")
  end
end
